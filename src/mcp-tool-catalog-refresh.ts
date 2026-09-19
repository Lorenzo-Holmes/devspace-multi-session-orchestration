export interface ToolListChangedSender {
  sendToolListChanged(): Promise<void>;
}

/**
 * Sends one tools/list_changed notification after a session has a standalone
 * server-to-client stream. A failed send is not committed, so a later GET may
 * retry without changing any MCP tool state.
 */
export class McpToolCatalogRefreshTracker {
  private readonly sentSessions = new Set<string>();
  private readonly inFlightSessions = new Set<string>();

  async notifyOnce(
    sessionId: string,
    sender: ToolListChangedSender,
  ): Promise<"sent" | "already_sent" | "in_flight"> {
    if (this.sentSessions.has(sessionId)) return "already_sent";
    if (this.inFlightSessions.has(sessionId)) return "in_flight";

    this.inFlightSessions.add(sessionId);
    try {
      await sender.sendToolListChanged();
      this.sentSessions.add(sessionId);
      return "sent";
    } finally {
      this.inFlightSessions.delete(sessionId);
    }
  }

  remove(sessionId: string): void {
    this.sentSessions.delete(sessionId);
    this.inFlightSessions.delete(sessionId);
  }

  clear(): void {
    this.sentSessions.clear();
    this.inFlightSessions.clear();
  }
}
