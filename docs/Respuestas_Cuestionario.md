# Cuestionario de Análisis 

---

## 1. ¿Por qué un cliente ejecutándose en el navegador web requiere crear un `ObjectAdapter` sin endpoints (`createObjectAdapter("")`) y asociarlo a `servicePrx.ice_getConnection()`, y qué papel cumple `observer.ice_fixed(current.con)` en el servidor Java?

**Respuesta:**

En un callback tradicional (el caso del cliente JavaFX), el cliente crea un `ObjectAdapter` con un endpoint TCP, es decir, abre un puerto de escucha. El proxy del observador que envía al servidor lleva ese endpoint (`default -h <ip> -p <puerto>`), y el servidor abre una **segunda conexión**, de vuelta hacia el cliente, para invocarlo.

Un navegador no puede hacer eso. Por seguridad, JavaScript no puede abrir sockets de escucha, y además el navegador suele estar detrás de NAT o de un firewall. El único canal disponible es la conexión **saliente** WebSocket que el propio cliente abrió hacia el puerto `10002`. La solución es reutilizar esa conexión en sentido inverso:

1. **`communicator.createObjectAdapter("")`** crea un adaptador local **sin endpoints**. Puede alojar servants, pero no acepta conexiones nuevas. Su proxy no tiene dónde ser alcanzado por sí mismo.
2. **`connection.setAdapter(adapter)`**, con la conexión obtenida de `servicePrx.ice_getConnection()`, le dice al runtime: "las **peticiones entrantes** que lleguen por esta conexión deben despacharse a los servants de este adaptador". Con esto la conexión pasa a ser bidireccional: el cliente envía peticiones al servidor y, por el mismo socket, el servidor puede enviarle peticiones al cliente.
3. **`adapter.createProxy(identity)`** produce el proxy del observador. Como el adaptador no tiene endpoints, el proxy llega al servidor con `ice_getEndpoints().length == 0`: solo trae una identidad, sin dirección.

Un proxy sin endpoints es inútil para el servidor: si intentara invocarlo, Ice no sabría dónde conectarse y fallaría. Ahí actúa **`observer.ice_fixed(current.con)`** en `ChessServiceImpl.registerObserver`:

- `current.con` es la conexión por la que **llegó** la invocación `registerObserver`, es decir, el WebSocket del navegador.
- `ice_fixed(con)` devuelve un proxy **fijado** a esa conexión. Cada invocación que se haga con él (`onGameStateChanged`, `onGameFinished`) se envía por ese mismo WebSocket, sin buscar endpoints ni abrir conexiones nuevas.

Las dos mitades se complementan: el cliente declara "acepta peticiones entrantes por esta conexión" (`setAdapter`) y el servidor declara "enviaré las notificaciones por esa conexión" (`ice_fixed`). Si falta cualquiera de las dos, los eventos no llegan.

En el servidor, la condición es `observer != null && observer.ice_getEndpoints().length == 0 && current.con != null`. Así los clientes JavaFX, cuyos proxies sí traen endpoints TCP, se registran sin modificación y solo los clientes web pasan por `ice_fixed`.

**Detalle operativo:** como el canal de notificaciones es la misma conexión, no puede cerrarse por inactividad. Por eso el cliente configura `Ice.ACM.Client.Timeout = 0` (no cerrar por inactividad) y `Ice.ACM.Client.Heartbeat = 3` (`HeartbeatAlways`, que envía latidos para mantener viva la conexión). Gracias a esto el servidor puede empujar eventos en cualquier momento, sin *polling* (`setInterval`) del lado del cliente.

---

## 2.¿Cómo logra el mismo servant `ChessServiceImpl` en Java atender simultáneamente a clientes JavaFX por TCP (`10000`) y clientes JavaScript por WebSockets (`10002`) sin duplicar la lógica del negocio?

**Respuesta:**

Ice separa **qué se invoca** (el objeto y su servant) de **cómo viaja el mensaje** (el transporte). En `ChessServerApp` se crea **un único** `ObjectAdapter` con **dos endpoints**:

```java
String endpoint = String.format("default -p %d:ws -h 0.0.0.0 -p %d", port, wsPort);
ObjectAdapter adapter = communicator.createObjectAdapterWithEndpoints("ChessServerAdapter", endpoint);
adapter.add(servant, Util.stringToIdentity("ChessService"));
```

- `default -p 10000` es el endpoint TCP (el transporte por defecto, para JavaFX).
- `ws -h 0.0.0.0 -p 10002` es el endpoint WebSocket (para el navegador).

El servant se registra **una sola vez** bajo la identidad `ChessService`. El flujo es el mismo para ambos transportes:

1. Cada endpoint acepta conexiones a su manera: un socket TCP o un *handshake* HTTP Upgrade a WebSocket.
2. Una vez establecida la conexión, WebSocket solo **encapsula los mensajes del protocolo Ice** dentro de tramas WebSocket. Los bytes que llegan al adaptador son los mismos mensajes Ice (`Request`, `Reply`, etc.) que llegarían por TCP.
3. El runtime los decodifica, localiza el servant por identidad en el adaptador y ejecuta el método, con el mismo *thread pool* del servidor (`Ice.ThreadPool.Server.Size = 10`, `SizeMax = 50`).

La lógica de negocio queda centralizada y es independiente del transporte: `ChessServiceImpl` delega en `RoomManager` y `GameRoom`, que mantienen el estado en memoria, y las reglas viven en `ChessRules`, en el módulo `common/`. El servant nunca pregunta si la llamada vino por TCP o WebSocket. La única diferencia visible es `Current.con` (la conexión de la petición), que solo se usa en `registerObserver` para el caso BiDir.

El resultado es que Alice (JavaFX, TCP) y Bob (navegador, WebSocket) comparten la misma sala y el mismo `GameRoom`. Los observadores de ambos se guardan como `ChessObserverPrx` en el mismo mapa y se notifican en el mismo bucle de difusión, ya sea por una conexión TCP nueva hacia el endpoint del cliente (JavaFX) o por el WebSocket fijado con `ice_fixed` (navegador).

---

## 3. ¿Cómo registra el archivo generado `ChessService.js` el espacio de nombres `ChessApp` en el navegador y por qué es indispensable importar primero `Ice.min.js`?

**Respuesta:**

`slice2js` traduce `ChessService.ice` a un archivo JavaScript que **depende del runtime de Ice** y que no puede ejecutarse solo. Su estructura es una función autoinvocada que recibe tres parámetros, `(function(module, require, exports) { ... })`, y se invoca al final con valores según el entorno:

```js
(typeof(global) !== "undefined" && typeof(global.process) !== "undefined" ? module : undefined,
 ... window.Ice._require,   // require   (en el navegador)
 ... window);               // exports   (en el navegador)
```

En el navegador:

1. **`require` es `window.Ice._require`** y **`exports` es `window`**. La primera línea del cuerpo, `const Ice = require("ice").Ice;`, obtiene el runtime a través de esa función. `window.Ice` solo existe si `Ice.min.js` ya se ejecutó. Si no, la última línea falla con un `TypeError` al leer `_require` de `undefined`.
2. `Ice._ModuleRegistry.module("ChessApp")` obtiene o crea el objeto del módulo Slice `ChessApp`.
3. Sobre ese objeto se definen, con los ayudantes `Slice.defineEnum` y `Slice.defineOperations`, los enumerados (`PieceColor`, `GameStatus`...), las estructuras (`Position`, `GameState`...), las excepciones, el servant base `ChessApp.ChessObserver` y los proxies `ChessServicePrx` y `ChessObserverPrx`. Todos extienden clases del runtime (`Ice.Object`, `Ice.ObjectPrx`), y los marshalers usan sus utilidades de streams.
4. La última sentencia, `exports.ChessApp = ChessApp`, con `exports === window`, deja el módulo como **`window.ChessApp`**.

Por eso el orden de importación es obligatorio. `Ice.min.js` crea `window.Ice` y los registros que `ChessService.js` consume; `ChessService.js` publica `window.ChessApp`, que a su vez consume `ChessClientService`. En `chessClientService.js`, los imports de módulos ES se evalúan en el orden escrito, lo que garantiza la secuencia:

```js
import "../../lib/Ice.min.js";   // 1. crea window.Ice
import "./ChessService.js";      // 2. crea window.ChessApp
```

Se comprobó en el navegador que, tras cargar la página, `typeof window.Ice` y `typeof window.ChessApp` son `"object"`, y que `ChessApp.ChessServicePrx` y `ChessApp.ChessObserver` son funciones.

El archivo generado debe corresponder a la misma versión del runtime. Tanto `slice2js` como `lib/Ice.min.js` son 3.7.11, lo cual evita desajustes en el formato de marshaling.

---

## 4. Aunque el frontend en JavaScript calcula sugerencias visuales de casillas candidatas (`chessRulesHelper.js`), ¿por qué el servidor vuelve a validar cada movimiento en `GameRoom.makeMove`?

**Respuesta:**

Porque **el cliente no es de confianza**. El código JavaScript se ejecuta en una máquina que controla el usuario: cualquiera puede modificarlo desde las herramientas de desarrollo, escribir un cliente Ice propio o invocar `makeMove` directamente con coordenadas arbitrarias. `calculateLocalCandidateMoves` existe solo para dar **retroalimentación visual inmediata**, sin esperar un viaje de ida y vuelta, y su propio comentario lo aclara: *"La validación definitiva de jaque y legalidad autoritativa la realiza el Servidor Ice"*.

Las razones concretas por las que el servidor debe revalidar son estas:

- **Seguridad e integridad:** el servidor es la única fuente de verdad. Sin revalidación, un cliente alterado podría mover piezas del rival, mover fuera de turno o hacer movimientos imposibles.
- **El helper del cliente es incompleto a propósito:** calcula movimientos "candidatos" pero no evalúa si el propio rey queda en jaque. En cambio, `ChessRules.getLegalMoves` en el servidor simula cada movimiento y descarta los que dejan al rey propio en jaque.
- **Estado desactualizado y concurrencia:** el tablero que ve el cliente puede estar un instante atrasado respecto al del servidor, por ejemplo si el rival movió o se rindió justo antes. `GameRoom.makeMove` es `synchronized` y valida contra el estado real de ese momento.
- **Varios clientes heterogéneos:** el cliente JavaFX y el web tienen implementaciones distintas. Una sola validación central garantiza que ambos apliquen exactamente las mismas reglas, de modo que ninguno pueda desviarse del otro.

`GameRoom.makeMove` aplica, en orden, estas comprobaciones, y cada fallo lanza la excepción tipada del contrato Slice:

1. La partida debe estar en curso (`INPROGRESS`, `CHECKWHITE` o `CHECKBLACK`); si no, `InvalidMoveException`.
2. Debe ser el turno de quien invoca (comparación con `whitePlayer` / `blackPlayer`); si no, `NotPlayerTurnException`.
3. La casilla de origen debe estar dentro del tablero y contener una pieza **propia**; si no, `InvalidMoveException`.
4. El destino debe estar en `ChessRules.getLegalMoves(board, from)`; si no, `InvalidMoveException`.

Solo si pasan las cuatro se modifica el tablero, se registra la jugada y se **difunde** el nuevo estado a todos los observadores. El cliente web captura esas excepciones y las muestra (`err.reason`), pero el estado del juego nunca depende de lo que el cliente haya calculado.
