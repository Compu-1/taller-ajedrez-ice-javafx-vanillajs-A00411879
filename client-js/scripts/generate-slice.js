// Compila el contrato Slice a JavaScript usando el paquete npm `slice2js`.
//
// El paquete `slice2js@3.7.110` no funciona como CLI: su `bin` (index.js) no tiene
// shebang y solo exporta `compile()`. Por eso se invoca de forma programatica,
// lo que ademas es portable entre macOS, Linux y Windows.
const path = require("path");
const slice2js = require("slice2js");

const root = path.resolve(__dirname, "..");
const sliceFile = path.resolve(root, "../common/src/main/slice/ChessService.ice");
const outputDir = path.resolve(root, "src/services");

const child = slice2js.compile(
    [sliceFile, "--output-dir", outputDir, "-I" + slice2js.sliceDir],
    { stdio: "inherit" }
);

child.on("error", err => {
    console.error("No se pudo ejecutar slice2js:", err.message);
    process.exit(1);
});

child.on("exit", code => {
    if (code === 0) {
        console.log("Generado: " + path.join(outputDir, "ChessService.js"));
    }
    process.exit(code === null ? 1 : code);
});
