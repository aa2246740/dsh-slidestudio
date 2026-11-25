export async function runModelSwitchTransaction(input: {
  apply: () => void;
  activate: () => void | Promise<void>;
  /** rc.5 要等 agent.model.select 写回；同步回滚仍然兼容。 */
  rollback: () => void | Promise<void>;
}): Promise<void> {
  try {
    input.apply();
    await input.activate();
  } catch (error) {
    await input.rollback();
    throw error;
  }
}
