import { diagnosticContext } from "./diagnostic-context.js";

const MAXIMUM_CAUSE_CHARACTERS = 2_048;
const MAXIMUM_STACK_FRAMES = 8;

/**
 * One bounded, redacted line (plus stack frames) that says why something
 * failed: error name, system code such as ENOENT, and message. A system error
 * is expected, so its code is enough; any other error keeps its stack trace.
 */
export function errorCause(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    const raw = (error as Error & { code?: unknown }).code;
    const code = typeof raw === "string" ? raw : undefined;
    const head = `${error.name}${code === undefined ? "" : `[${code}]`}: ${error.message}`;
    const frames = code === undefined && typeof error.stack === "string"
      ? error.stack.split("\n").filter((line) => line.trimStart().startsWith("at ")).slice(0, MAXIMUM_STACK_FRAMES).map((line) => `  ${line.trim()}`)
      : [];
    text = [head, ...frames].join("\n");
  } else {
    let described: string;
    try { described = typeof error === "string" ? error : JSON.stringify(error) ?? String(error); }
    catch { described = Object.prototype.toString.call(error); } // a value JSON cannot encode still gets its type
    text = `Non-Error thrown: ${described}`;
  }
  return String(diagnosticContext(text)).slice(0, MAXIMUM_CAUSE_CHARACTERS);
}
