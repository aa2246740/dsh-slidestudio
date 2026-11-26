import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@open-slidestudio/pptd-v2";
import { createPresentationRun } from "@open-slidestudio/presentation-run";
import { createSlideTools, isSlideToolArgsError } from "@open-slidestudio/slides-tools";
import { sliceProjectPort } from "../../packages/dsh-slides-host/dist/session-runtime-config.js";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = path.join(ROOT, "output", "argument-replay");
const BASELINE = path.join(FIXTURE, "project-baseline");
const WORK = path.join(FIXTURE, "project-work");
const PAYLOAD_FILE = path.join(FIXTURE, "write-page-payload.json");
const REPLAY_SESSION = "argument-replay-b7c22a8e";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function prepareWorkProject() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.cpSync(BASELINE, WORK, { recursive: true });
  const agent = path.join(WORK, "_agent");
  const presentationBinding = readJson(path.join(agent, "presentation-run.v1.json"));
  writeJson(path.join(agent, "presentation-run.v1.json"), {
    ...presentationBinding,
    projectRoot: WORK,
    runId: REPLAY_SESSION,
    sessionId: REPLAY_SESSION,
    editorBaseUrl: "",
  });
  const sliceBinding = readJson(path.join(agent, "slice-session.v1.json"));
  writeJson(path.join(agent, "slice-session.v1.json"), {
    ...sliceBinding,
    dshSessionId: REPLAY_SESSION,
    projectRoot: WORK,
  });
  const ledgerPath = path.join(agent, "run-ledger.v1.json");
  const ledger = readJson(ledgerPath);
  writeJson(ledgerPath, { ...ledger, runId: REPLAY_SESSION });
  const runtimePath = path.join(agent, "runtime.json");
  const runtime = readJson(runtimePath);
  writeJson(runtimePath, { ...runtime, editorBaseUrl: "" });
  return sliceBinding.provider;
}

function findPage(project, pageId) {
  return project.pages.find((entry) => entry.page.id === pageId || path.basename(entry.path, ".page") === pageId);
}

function pageDigest(projectRoot, project, pageId) {
  const loaded = findPage(project, pageId);
  if (!loaded) return undefined;
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.resolve(projectRoot, loaded.path)))
    .digest("hex");
}

const payload = readJson(PAYLOAD_FILE);
assert.deepEqual(Object.keys(payload), ["arguments"], "fixture must retain the exact outer arguments envelope");
assert.equal(typeof payload.arguments?.id, "string", "fixture must contain a page id inside arguments");
assert.ok(Array.isArray(payload.arguments?.elements), "fixture must contain the original elements array");

const provider = prepareWorkProject();
const binding = {
  ...readJson(path.join(WORK, "_agent", "slice-session.v1.json")),
  provider,
};
const signal = new AbortController().signal;
const store = {
  bindingFor(sessionId) {
    return sessionId === REPLAY_SESSION ? binding : undefined;
  },
  resolveRoot() {
    return WORK;
  },
};

const presentation = createPresentationRun({ repoRoot: ROOT });
// The canonical slide tool the Hub's SlidesAgentRuntime runs, over the Hub store port.
const writePage = createSlideTools({
  presentation,
  editorBaseUrl: "",
  projects: sliceProjectPort(store, {
    providerId: provider.providerId,
    modelId: provider.modelId,
    inputModalities: [],
  }),
}).find((tool) => tool.name === "write_page");
assert.ok(writePage, "the canonical suite must define write_page");

async function execute(callId, args) {
  const ctx = {
    callId,
    signal,
    caller: { kind: "hub-run", id: `hub-run:${REPLAY_SESSION}` },
    sessionId: REPLAY_SESSION,
    projectId: binding.projectRoot,
    projectRoot: WORK,
  };
  try {
    writePage.validate?.(args);
    const result = await writePage.execute(args, ctx);
    return { isError: false, value: result.data };
  } catch (error) {
    if (isSlideToolArgsError(error)) return { isError: true, error: { info: { code: "INVALID_ARGS" } } };
    throw error;
  }
}

{
  // pi-agent-core hands tools the model's declared fields directly; the captured
  // provider envelope is unwrapped once, exactly as the provider transport does.
  const original = await execute("argument-replay-original", payload.arguments);
  assert.equal(
    original.isError,
    false,
    `canonical write_page rejected the original argument envelope (${original.error?.code ?? "unknown"})`,
  );
  assert.equal(original.value?.outcome, "rejected", "the captured payload must retain its downstream layout failure");
  assert.match(
    String(original.value?.detail ?? ""),
    /text el-03 overlaps el-04[\s\S]*text el-08 overlaps el-10/,
    "the exact original payload must reach the product layout validator",
  );
  assert.equal(
    pageDigest(WORK, loadProject(WORK), payload.arguments.id),
    undefined,
    "rejected original payload must not paint a page",
  );

  // Keep the captured fixture exact. This in-memory variant changes only the
  // two reported bounds so the same registered execution path can prove that a
  // valid call persists bytes instead of merely returning a mocked success.
  const corrected = structuredClone(payload);
  corrected.arguments.elements[3].bounds[1] = 140;
  corrected.arguments.elements[7].bounds[3] = 28;
  const valid = await execute("argument-replay-corrected", corrected.arguments);
  assert.equal(
    valid.isError,
    false,
    `canonical write_page rejected the corrected argument envelope (${valid.error?.code ?? "unknown"})`,
  );
  assert.ok(
    valid.value?.outcome === "written" || valid.value?.outcome === "skipped-identical",
    `corrected write_page did not persist (outcome=${valid.value?.outcome ?? "missing"}; detail=${valid.value?.detail ?? "none"})`,
  );

  const written = loadProject(WORK);
  const pageId = payload.arguments.id;
  const writtenPage = findPage(written, pageId);
  assert.ok(writtenPage, `write_page reported success but ${pageId} is absent from the copied project`);
  assert.equal(
    writtenPage.page.elements.length,
    corrected.arguments.elements.length,
    "persisted page must retain every original element",
  );
  const beforeInvalid = pageDigest(WORK, written, pageId);
  assert.ok(beforeInvalid, "persisted page must have bytes on disk");

  const invalid = await execute("argument-replay-invalid", { elements: payload.arguments.elements });
  assert.equal(invalid.isError, true, "missing id must still fail registered schema validation");
  assert.equal(invalid.error?.info?.code, "INVALID_ARGS", "schema rejection must remain ToolArgsError/INVALID_ARGS");
  const afterInvalid = pageDigest(WORK, loadProject(WORK), pageId);
  assert.equal(afterInvalid, beforeInvalid, "invalid replay must not mutate the written page");

  const report = {
    ok: true,
    registeredTool: "write_page",
    sourceEnvelope: "arguments",
    originalOutcome: original.value.outcome,
    originalDownstreamIssue: "overlap",
    outcome: valid.value.outcome,
    pageId,
    elementsPersisted: writtenPage.page.elements.length,
    pageFile: path.relative(ROOT, path.resolve(WORK, writtenPage.path)),
    schemaRejection: invalid.error.info.code,
    invalidMutation: false,
  };
  writeJson(path.join(FIXTURE, "replay-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}
