/**
 * The route-facing handle of one live slide session. Routes queue user text
 * through `followup` (start a turn) or `steer` (inject into the running turn);
 * the session runtime manager maps both onto `SlidesAgentRuntime`. The message
 * shape stays structural so routes and tests never import a host SDK.
 */

export type SessionTurnMessage = {
  readonly role: "user";
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly source: { readonly kind: "user" };
};

export type SessionFollowupOptions = {
  /** Start this turn from a compact disk summary instead of replaying full raw history. */
  readonly seedFromSummary?: string;
};

export interface SlidesSessionHandle {
  readonly status?: "idle" | "running";
  /** Start a new turn with this user message (fire-and-forget). */
  followup(message: SessionTurnMessage, options?: SessionFollowupOptions): void;
  /** Inject this user message after the current assistant step of the running turn. */
  steer(message: SessionTurnMessage): void;
}

export function userTurnMessage(text: string): SessionTurnMessage {
  return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

export function turnMessageText(message: SessionTurnMessage): string {
  return message.content.map((block) => block.text).join("\n");
}
