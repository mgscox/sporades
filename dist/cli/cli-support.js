export function errorDetails(error) {
    if (error === null || error === undefined) {
        return {};
    }
    return typeof error === "object" ? error : { message: String(error) };
}
export function commandError(message, hint, diagnostics = null) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics) {
        error.diagnostics = diagnostics;
    }
    return error;
}
export function helperError(message, hint, diagnostics = null) {
    const error = new Error(message);
    error.hint = hint;
    if (diagnostics) {
        error.diagnostics = diagnostics;
    }
    return error;
}
export function readStdin() {
    return new Promise((resolve, reject) => {
        let stdin = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            stdin += chunk;
        });
        process.stdin.on("end", () => resolve(stdin));
        process.stdin.on("error", reject);
    });
}
export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function writeResult(result, failed = false) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failed) {
        process.exitCode = 1;
    }
}
export function writeEnvelope(result, failed = false) {
    writeResult(result, failed);
}
//# sourceMappingURL=cli-support.js.map