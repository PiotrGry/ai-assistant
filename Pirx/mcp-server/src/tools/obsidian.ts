import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { ObsidianVault } from "../obsidian/vaults.js";

export function registerObsidianTools(server: McpServer): void {
  const vaultPath = process.env["PIRX_OBSIDIAN_VAULT"];

  if (!vaultPath) {
    throw new Error("PIRX_OBSIDIAN_VAULT is not set");
  }

  const vault = new ObsidianVault(vaultPath);

  server.registerTool(
    "obsidian_read",
    {
      title: "Czytaj notatkę z Obsidiana",
      description: "Odczytaj plik Markdown z vaulta Obsidiana.",
      inputSchema: z.object({
        path: z.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const content = await vault.read(path);

      return {
        content: [{ type: "text", text: content }],
      };
    },
  );

  server.registerTool(
    "obsidian_create",
    {
      title: "Utwórz notatkę w Obsidianie",
      description: "Utwórz nowy plik Markdown w vaultcie Obsidiana.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, content }) => {
      await vault.create(path, content);

      return {
        content: [{ type: "text", text: `Created ${path}` }],
      };
    },
  );

  server.registerTool(
    "obsidian_append",
    {
      title: "Dopisz do notatki w Obsidianie",
      description: "Dopisz tekst do istniejącego pliku Markdown.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, content }) => {
      await vault.append(path, content);

      return {
        content: [{ type: "text", text: `Appended to ${path}` }],
      };
    },
  );

  server.registerTool(
    "obsidian_search",
    {
      title: "Szukaj w Obsidianie",
      description: "Znajdź pliki Markdown pasujące do zapytania.",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const results = await vault.search(query);

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
      };
    },
  );
}
