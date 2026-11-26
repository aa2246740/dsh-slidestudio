function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** rc.2 puts result content on the tool message; older journals wrap it in a block. */
export function toolResultMessage(value: unknown): Record<string, unknown> | undefined {
  const message = record(value);
  if (message?.role === "tool" && typeof message.toolCallId === "string" && message.toolCallId) {
    return message;
  }
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.map(record).find((block) => block?.type === "tool-result");
}
