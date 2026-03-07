export type KeyboardCommand = "delete-selection" | "open-add-actor-browser";

export type KeyboardCommandHandler = (event: KeyboardEvent) => boolean;

interface HandlerEntry {
  id: number;
  priority: number;
  handler: KeyboardCommandHandler;
}

class KeyboardCommandRouter {
  private readonly handlersByCommand = new Map<KeyboardCommand, HandlerEntry[]>();
  private nextId = 1;

  public register(command: KeyboardCommand, handler: KeyboardCommandHandler, priority = 0): () => void {
    const handlers = this.handlersByCommand.get(command) ?? [];
    const entry: HandlerEntry = {
      id: this.nextId++,
      priority,
      handler
    };
    handlers.push(entry);
    this.handlersByCommand.set(command, handlers);
    return () => {
      const current = this.handlersByCommand.get(command);
      if (!current) {
        return;
      }
      const filtered = current.filter((candidate) => candidate.id !== entry.id);
      if (filtered.length === 0) {
        this.handlersByCommand.delete(command);
        return;
      }
      this.handlersByCommand.set(command, filtered);
    };
  }

  public dispatch(command: KeyboardCommand, event: KeyboardEvent): boolean {
    const handlers = this.handlersByCommand.get(command);
    if (!handlers || handlers.length === 0) {
      return false;
    }
    const ordered = [...handlers].sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.id - a.id;
    });
    for (const entry of ordered) {
      if (entry.handler(event)) {
        return true;
      }
    }
    return false;
  }
}

export const keyboardCommandRouter = new KeyboardCommandRouter();
