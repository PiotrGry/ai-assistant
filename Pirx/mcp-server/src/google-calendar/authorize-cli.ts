import { loadMcpServerConfig } from "../config.js";
import { authorizeGoogleCalendar } from "./authorize.js";

authorizeGoogleCalendar(loadMcpServerConfig().googleCalendar).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Google Calendar authorization failed: ${detail}`);
  process.exitCode = 1;
});
