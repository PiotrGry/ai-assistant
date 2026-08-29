import { arch, hostname, release, type } from "node:os";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const systemInfoSchema = z.object({
  hostname: z.string(),
  os: z.string(),
  os_release: z.string(),
  architecture: z.string(),
  node: z.string(),
});

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "system_info",
    {
      title: "Informacje o systemie",
      description: "Zwróć podstawowe informacje o systemie, na którym działa Pirx.",
      outputSchema: systemInfoSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const result = {
        hostname: hostname(),
        os: type(),
        os_release: release(),
        architecture: arch(),
        node: process.version,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
