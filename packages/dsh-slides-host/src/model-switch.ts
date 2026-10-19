export async function runModelSwitchTransaction(input: {
  apply: () => void;
  activate: () => void | Promise<void>;
  rollback: () => void;
}): Promise<void> {
  try {
    input.apply();
    await input.activate();
  } catch (error) {
    input.rollback();
    throw error;
  }
}
