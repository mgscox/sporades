export type LooseRecord = Record<string, any>;

export type CommandError = Error & { hint?: string; diagnostics?: unknown };
export type HelperError = Error & { hint?: string; diagnostics?: unknown };

export function errorDetails(error: unknown): LooseRecord {
  if (error === null || error === undefined) {
    return {};
  }
  return typeof error === "object" ? (error as LooseRecord) : { message: String(error) };
}

export function commandError(message: string, hint: string, diagnostics: unknown = null): CommandError {
  const error: CommandError = new Error(message);
  error.hint = hint;
  if (diagnostics) {
    error.diagnostics = diagnostics;
  }
  return error;
}

export function helperError(message: string, hint: string, diagnostics: unknown = null): HelperError {
  const error: HelperError = new Error(message);
  error.hint = hint;
  if (diagnostics) {
    error.diagnostics = diagnostics;
  }
  return error;
}

export function readStdin(): Promise<string> {
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

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function writeResult(result: LooseRecord, failed = false) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failed) {
    process.exitCode = 1;
  }
}

export function writeEnvelope(result: LooseRecord, failed = false) {
  writeResult(result, failed);
}
