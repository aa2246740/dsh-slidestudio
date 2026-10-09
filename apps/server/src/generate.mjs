import { HttpInputError } from "./http-input.mjs";

export function assertGenerationInput(body) {
  const prompt = String(body.prompt || "").trim();
  const hasPins = Array.isArray(body.pins) && body.pins.length > 0;
  if (!prompt && !body.references?.length && !hasPins) throw new HttpInputError(400, "prompt required");
}

export async function generate(body, agent) {
  const prompt = String(body.prompt || "").trim();
  const pins = Array.isArray(body.pins) ? body.pins : undefined;
  const modelId = body.modelId || body.model || "auto";
  const provider =
    modelId === "mock-offline" || modelId === "mock"
      ? new agent.MockProvider({ baseDelayMs: 40 })
      : agent.resolveProvider({ modelId: modelId === "auto" ? undefined : modelId });
  const steps = [];
  const run = agent.createAgentRun(
    {
      prompt: prompt || (pins?.length ? `Process ${pins.length} agent annotation(s)` : "Create slides from references"),
      title: body.title,
      templateId: body.templateId,
      modelId,
      references: body.references,
      designContract: body.designContract,
      baseDeck: body.baseDeck,
      baseVersionId: body.baseVersionId,
      baseVersionNumber: body.baseVersionNumber,
      pins,
      mockSpeed: 0,
    },
    { provider, autoStart: true },
  );
  run.subscribe((event) => {
    if (event.type === "tool_started") {
      steps.push({ id: event.stepId, tool: event.tool, label: event.label, target: event.target, status: "running" });
    } else {
      const step = steps.find((value) => value.id === event.stepId);
      if (step && event.type === "tool_completed") Object.assign(step, { status: "completed", summary: event.summary });
      if (step && event.type === "tool_failed") Object.assign(step, { status: "failed", error: event.error });
    }
  });
  const result = await run.wait();
  return {
    deck: result.deck,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    versionLabel: result.versionLabel,
    summary: result.summary,
    steps: result.steps?.length ? result.steps : steps,
    pinBatch: result.pinBatch,
    provider: provider.id,
    displayName: provider.displayName,
  };
}
