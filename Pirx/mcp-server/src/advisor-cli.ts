import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RuntimeSqliteStore } from "@pirx/orchestrator";
import { createAdvisorServer } from "./advisor.js";

const [filename, taskId, attemptId] = process.argv.slice(2);
if (!filename || !taskId || !attemptId) throw Error("Advisor requires database, Task and Attempt binding");
const store = RuntimeSqliteStore.open({ filename });
const handle = serveStdio(() => createAdvisorServer(store, taskId, attemptId));
const keepAlive = setInterval(() => undefined, 60_000);
process.stdin.resume();
process.stdin.once("end", () => { clearInterval(keepAlive); void handle.close().finally(() => store.close()); });
