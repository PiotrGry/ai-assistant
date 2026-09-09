export interface ToolStartedEvent {
  readonly type: "tool-started";
  readonly name: string;
}

export interface ToolFinishedEvent {
  readonly type: "tool-finished";
  readonly name: string;
  readonly isError: boolean;
  readonly text: string;
  readonly durationMs: number;
}

export interface McpUnavailableEvent {
  readonly type: "mcp-unavailable";
  readonly reason: string;
}

export type TuiEvent =
  | ToolStartedEvent
  | ToolFinishedEvent
  | McpUnavailableEvent;

export class TuiEventBus {
  #listeners = new Set<(event: TuiEvent) => void>();

  subscribe(listener: (event: TuiEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: TuiEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
