// El orden importa: Ice.min.js crea window.Ice y ChessService.js registra window.ChessApp sobre él.
import "../../lib/Ice.min.js";
import "./ChessService.js";
import { ChessRealtimeObserver } from "./chessRealtimeObserver.js";

/**
 * Servicio de comunicación RPC con ZeroC Ice sobre WebSockets.
 * Encapsula el ciclo de vida del Communicator, el proxy de ChessService
 * y la suscripción en tiempo real mediante ChessRealtimeObserver.
 */

export class ChessClientService {
    constructor() {
        this.Ice = window.Ice;
        this.ChessApp = window.ChessApp;

        this.communicator = null;
        this.service = null;
        this.realtimeObserver = null;
        this.isConnected = false;

        this.nickname = null;
        this.currentRoomCode = null;
        this.role = null;
        this.assignedColor = null;
    }

    validateRuntime() {
        if (!this.Ice || !this.ChessApp) {
            throw new Error(
                "El runtime de ZeroC Ice no está disponible (window.Ice / window.ChessApp). " +
                "Verifica lib/Ice.min.js y que ChessService.js haya sido generado con 'npm run generate-slice'."
            );
        }
    }

    async connect(host, port, nickname) {
        this.validateRuntime();

        if (this.communicator) {
            await this.communicator.destroy();
            this.communicator = null;
        }
        this.isConnected = false;

        const initData = new this.Ice.InitializationData();
        initData.properties = this.Ice.createProperties();
        initData.properties.setProperty("Ice.MessageSizeMax", "2048");
        initData.properties.setProperty("Ice.ACM.Client.Timeout", "0");
        initData.properties.setProperty("Ice.ACM.Client.Heartbeat", "3");
        this.communicator = this.Ice.initialize(initData);

        const targetHost = host || "127.0.0.1";
        const targetPort = port || 10002;
        const base = this.communicator.stringToProxy(`ChessService:ws -h ${targetHost} -p ${targetPort}`);
        this.service = await this.ChessApp.ChessServicePrx.checkedCast(base);
        if (!this.service) {
            throw new Error(`El proxy en ${targetHost}:${targetPort} no implementa ChessService.`);
        }

        this.realtimeObserver = new ChessRealtimeObserver(this.Ice, this.ChessApp);
        this.nickname = nickname;
        this.isConnected = true;
    }

    async getLobbyData() {
        this.ensureConnected();
        const [rooms, leaderboard] = await Promise.all([
            this.service.getActiveRooms(),
            this.service.getLeaderboard()
        ]);
        return { rooms, leaderboard };
    }

    async createRoom(nickname) {
        this.ensureConnected();
        return this.service.createRoom(this.nickname);
    }

    async joinRoom(roomCode, nickname) {
        this.ensureConnected();
        const normalizedCode = roomCode.trim().toUpperCase();
        const result = await this.service.joinRoom(normalizedCode, this.nickname);

        this.currentRoomCode = normalizedCode;
        this.role = result.role;
        this.assignedColor = result.assignedColor;
        return result;
    }

    async subscribeToRoom(listeners = {}) {
        this.ensureConnected();
        await this.realtimeObserver.subscribe(
            this.communicator, this.service, this.currentRoomCode, this.nickname, listeners
        );
    }

    async makeMove(fromRow, fromCol, toRow, toCol) {
        this.ensureConnected();
        const fromPos = new this.ChessApp.Position(fromRow, fromCol);
        const toPos = new this.ChessApp.Position(toRow, toCol);
        return this.service.makeMove(this.currentRoomCode, this.nickname, fromPos, toPos);
    }

    async resign() {
        this.ensureConnected();
        await this.service.resign(this.currentRoomCode, this.nickname);
    }

    async leaveRoom() {
        this.ensureConnected();
        const roomCode = this.currentRoomCode;
        if (!roomCode) {
            return;
        }

        try {
            await this.realtimeObserver.unsubscribe(this.service, roomCode, this.nickname);
            await this.service.leaveRoom(roomCode, this.nickname);
        } finally {
            this.currentRoomCode = null;
            this.role = null;
            this.assignedColor = null;
        }
    }

    ensureConnected() {
        if (!this.isConnected || !this.service) {
            throw new Error("No hay conexión con el servidor Ice. Conéctate primero.");
        }
    }
}
