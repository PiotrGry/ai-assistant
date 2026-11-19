import type { McpServer } from "@modelcontextprotocol/server";

import { registerActionTools } from "./actions.js";
import { registerFactTools } from "./facts.js";
import { registerJournalTools } from "./journal-tools.js";
import { runCommand, type Runner } from "./shell.js";
import { loadCoordinationSettings } from "./settings.js";
import { CoordinationStore, defaultStoragePath } from "./store.js";
import type { CoordinationContext } from "./toolkit.js";
import { registerWorkerTools } from "./worker.js";

/** The coordination toolset of docs/control-center-refactor.md: facts, worker, actions and journal. */
export function registerCoordinationTools(server: McpServer, environment: NodeJS.ProcessEnv, options: { readonly run?: Runner; readonly store?: CoordinationStore } = {}): CoordinationContext {
  const context: CoordinationContext = {
    store: options.store ?? new CoordinationStore(defaultStoragePath(environment)),
    settings: loadCoordinationSettings(environment),
    run: options.run ?? runCommand,
    environment,
  };
  registerFactTools(server, context);
  registerWorkerTools(server, context);
  registerActionTools(server, context);
  registerJournalTools(server, context);
  return context;
}
