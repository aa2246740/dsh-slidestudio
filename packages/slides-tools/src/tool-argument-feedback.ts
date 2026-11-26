/**
 * Host-neutral wording for repeated invalid tool arguments. Hosts track the
 * streak with their own event model and append this warning on the second
 * identical failure, before a third one stops the run.
 */
export const TOOL_INVALID_ARGS_WARNING_PREFIX = "参数重试警告：";

export function invalidArgsStreakWarning(toolName: string): string {
  return `${TOOL_INVALID_ARGS_WARNING_PREFIX}${toolName} 已连续两次出现相同参数错误；再重复一次相同错误将停止本次运行。请先修正上述字段，不要原样重发。`;
}
