import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const helloResultSchema = z.object({
  greeting: z.string(),
});

export function registerHelloTool(server: McpServer): void {
  server.registerTool(
    "hello",
    {
      title: "Przywitanie",
      description: "Przywitaj wskazaną osobę.",
      inputSchema: z.object({
        name: z.string().trim().min(1).describe("Imię osoby"),
      }),
      outputSchema: helloResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) => {
      const result = { greeting: `Hello, ${name}!` };

      return {
        content: [{ type: "text", text: result.greeting }],
        structuredContent: result,
      };
    },
  );
}
