import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createPresentationRun, readRunLedger, type PresentationCommand } from "@open-slidestudio/presentation-run";
import { attachmentsStoreDir, readMaterialsManifest, type MaterialKind } from "@open-slidestudio/slides-tools";
import { materialManifestEntry } from "@open-slidestudio/slides-tools/internal/material-input";
import { AgentFaults } from "./agent-fault.js";
import { buildDiskContextSummary } from "./context-summary.js";
import type { DshGenerateOptionsLike, DshStreamChunk } from "./dsh-llm-port.js";
import {
  attachmentDeliveryBlock,
  inputSha256,
  toMaterialAttachment,
  verifiedAttachment,
  type GenerationInputSnapshot,
} from "./generation-input.js";
import { HostModels } from "./host-models.js";
import { invokeSlides, REPO_ROOT } from "./host-test-fixtures.js";
import { resolveEditorAttachments, type SlidesHostRuntime } from "./routes.js";
import { SessionCommands } from "./session-commands.js";
import { SessionRecovery } from "./session-recovery.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";
import { SliceSessionStore } from "./slice-session.js";

const model = { provider: "scripted", model: "scripted-1" };
const editorBaseUrl = "http://127.0.0.1:9";
const materialsTools = ["list_materials", "read_material", "query_material"];

type Fixture = {
  name: string;
  kind: MaterialKind;
  parser: string;
  original: string | Buffer;
  content: Record<string, unknown>;
  inlineText?: string;
  preview?: string;
};

const mdText = "# Inventory\nInventory is 317 units.";
const csvText = "Region,Price\nNorth,84\nSouth,24\n";
const longText = "Appendix starts here.\n" + "abcd".repeat(13_000);
const xlsx = fs.readFileSync(path.join(REPO_ROOT, "test-fixtures/monthly/monthly-generic.xlsx"));
const png = "test-fixtures/edit-ops-project/media/logo-a.png";
const fixtures = {
  docx: {
    name: "report.docx",
    kind: "document",
    parser: "docx-ooxml-v1",
    original: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]),
    content: { document: { blocks: [{ type: "paragraph", text: "Order volume is 172." }] } },
  },
  xlsx: {
    name: "workbook.xlsx",
    kind: "table",
    parser: "xlsx-ooxml-v1",
    original: xlsx,
    content: {
      table: {
        sheets: [
          { name: "Sales", headerRow: ["Region", "Price"], rowCount: 1, colCount: 2, fullRows: [["North", 212]] },
        ],
      },
    },
  },
  pdf: {
    name: "report.pdf",
    kind: "document",
    parser: "pdf-unpdf-v4",
    original: "%PDF-1.7\n% fixture\n%%EOF",
    content: { document: { pageCount: 1, pages: [{ index: 1, text: "PDF total is 481." }] } },
  },
  image: {
    name: "mark.png",
    kind: "image",
    parser: "image-sharp-v1",
    original: fs.readFileSync(path.join(REPO_ROOT, png)),
    content: { image: { format: "png", width: 1, height: 1 } },
  },
  pptx: {
    name: "template.pptx",
    kind: "deck-template",
    parser: "pptx-ooxml-v1",
    original: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x02]),
    content: { "deck-template": { theme: { colors: { accent1: "#4141AA" } }, masters: [], slides: [] } },
  },
  csv: {
    name: "sales.csv",
    kind: "table",
    parser: "csv-v1",
    original: csvText,
    inlineText: csvText,
    content: { table: { headerRow: ["Region", "Price"], rowCount: 2, colCount: 2 } },
  },
  md: {
    name: "inventory.md",
    kind: "text",
    parser: "text-utf8-v1",
    original: mdText,
    inlineText: mdText,
    content: { text: { text: mdText, chars: mdText.length } },
  },
  long: {
    name: "appendix.txt",
    kind: "text",
    parser: "text-utf8-v1",
    original: longText,
    preview: longText,
    content: { text: { text: longText, chars: longText.length } },
  },
} satisfies Record<string, Fixture>;
type FixtureId = keyof typeof fixtures;

function writeAttachment(dataRoot: string, id: string, fixture: Fixture) {
  const { name, kind, parser, original, inlineText, preview, content } = fixture;
  const originalBytes = Buffer.from(original);
  const dir = attachmentsStoreDir(dataRoot);
  const storeId = inputSha256(dir);
  const originalSha256 = inputSha256(originalBytes);
  const summary = { zh: `解析摘要 ${name}` };
  const derivative = JSON.stringify({
    schema: "material-derivative/v1",
    materialId: id,
    kind,
    status: "ok",
    parser: { id: parser },
    source: { sha256: originalSha256, extension: path.extname(name), bytes: originalBytes.length },
    summary,
    warnings: [],
    ...content,
  });
  const derivativeSha256 = inputSha256(derivative);
  const receipt = { id, name, size: originalBytes.length, storeId, originalSha256, derivativeSha256 };
  const file = path.join(dir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, originalBytes);
  fs.writeFileSync(`${file}.meta.json`, JSON.stringify({ ...receipt, kind, parser, status: "ok" }));
  fs.writeFileSync(`${file}.derivative.json`, derivative);
  const resolved = {
    ...receipt,
    kind,
    parser,
    status: "parsed",
    summary,
    needsVision: kind === "image",
    bytes: receipt.size,
  };
  const text = inlineText ?? preview;
  if (text === undefined) return resolved;
  return {
    ...resolved,
    text,
    textSha256: inputSha256(text),
    chars: text.length,
    parsed: true,
    complete: true,
    ...(inlineText === undefined ? {} : { parser: "utf8-full-v1", materialParser: parser }),
  };
}

function testHost(t: TestContext, vision = false) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "host-session-materials-"));
  const dshHome = path.join(dataRoot, "home");
  const store = new SliceSessionStore(dataRoot);
  const presentation = createPresentationRun({ repoRoot: REPO_ROOT });
  const inputModalities = vision ? ["text", "image"] : ["text"];
  const models = new HostModels(
    {
      listProviders: () => [{ id: model.provider }],
      listModels: async () => [{ id: model.model, inputModalities }],
      resolveModelInfo: async () => ({ inputModalities }),
    },
    { dshHome, personal: true },
  );
  const receipts = new Map<string, ReturnType<typeof writeAttachment>>();
  const requests: DshGenerateOptionsLike[] = [];
  const busy = new Set<string>();
  const events = new EventEmitter();
  const manager = new SessionRuntimeManager({
    store,
    presentation,
    editorBaseUrl,
    llm: {
      async *stream(options): AsyncIterable<DshStreamChunk> {
        requests.push(options);
        yield { type: "text-delta", index: 0, text: "Received." };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
    resolveLimits: async () => ({ contextWindow: 128_000, maxTokens: 8192 }),
    onStatus: (id, status) => {
      if (status === "running") busy.add(id);
      else {
        busy.delete(id);
        events.emit("idle");
      }
    },
  });
  t.after(async () => {
    await manager.dispose();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  const recovery = new SessionRecovery({
    store,
    faults: new AgentFaults(),
    reopen: async () => {},
    continueSession: () => {},
    markBusy: (id) => busy.add(id),
    markIdle: (id) => busy.delete(id),
    grokFallbackTarget: () => undefined,
    openrouterKeyPresent: () => false,
    minimaxCnKeyPresent: () => false,
  });
  const commands = new SessionCommands({
    store,
    presentation,
    workspaceRoot: REPO_ROOT,
    dataRoot,
    dshHome,
    editorBaseUrl,
    models,
    manager,
    recovery,
    busy,
    currentXai: () => ({ status: "signed-out" }),
    bindGrokProduce: () => {},
    renderRuntime: { current: () => undefined, snapshot: () => ({ phase: "ready" }) },
  });
  const runtime: SlidesHostRuntime = {
    store,
    presentation,
    workspaceRoot: REPO_ROOT,
    dataRoot,
    dshHome,
    agentBusy: (id) => busy.has(id),
    markBusy: (id) => busy.add(id),
    cancelRateLimitWait: (id) => recovery.onUserTurn(id),
    operatorStop: (id) => commands.operatorStop(id),
    getAgent: (id) => manager.handle(id),
    createAgent: (input) => commands.createAgent(input),
    resumeAgent: (id) => commands.resumeAgent(id),
    switchModel: (id, next, provider, effort) => commands.switchModel(id, next, provider, effort),
    resolveAttachments: (ids) =>
      resolveEditorAttachments(
        ids,
        async (url) => {
          const id = decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!);
          const receipt = receipts.get(id);
          return receipt ? Response.json(receipt) : Response.json({ error: "missing" }, { status: 404 });
        },
        editorBaseUrl,
      ),
  };
  const create = (attachments: string[], extra = {}) =>
    invokeSlides(runtime, "POST", "/slides/sessions", {
      brief: "Use the selected source files",
      ...model,
      attachments,
      ...extra,
    });
  const turn = (sessionId: string, attachments: string[]) =>
    invokeSlides(runtime, "POST", `/slides/sessions/${sessionId}/turn`, { text: "Use these sources too", attachments });
  const upload = (...ids: FixtureId[]) => {
    for (const id of ids) receipts.set(id, writeAttachment(dataRoot, id, fixtures[id]));
    return ids;
  };
  const accepted = async (response: Awaited<ReturnType<typeof create>>) => {
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const { sessionId } = response.json as { sessionId: string };
    const binding = store.bindingFor(sessionId);
    assert.ok(binding);
    if (busy.has(sessionId)) await once(events, "idle", { signal: AbortSignal.timeout(5_000) });
    return { sessionId, root: store.resolveRoot(binding) };
  };
  const read = (sessionId: string, root: string, name: string, args: PresentationCommand["args"] = {}) =>
    presentation.execute(
      { name, args },
      {
        runId: sessionId,
        sessionId,
        projectRoot: root,
        toolCallId: `${name}-${args.materialId ?? "all"}`,
        abortSignal: new AbortController().signal,
      },
    );
  return { dataRoot, runtime, requests, busy, create, turn, upload, accepted, read };
}

function actualTurn(request: DshGenerateOptionsLike | undefined): string {
  assert.ok(request, "the scripted model received the turn");
  const block = request.messages.filter((message) => message.role === "user").at(-1)?.content[0];
  assert.ok(block && "text" in block && typeof block.text === "string");
  return block.text;
}

test("material receipts round-trip, keep verified inline metadata, and discard non-inline text previews", (t) => {
  const host = testHost(t);
  const body = writeAttachment(host.dataRoot, "notes", fixtures.md);
  const extra = {
    parts: [{ part: "text", label: "Text", chars: mdText.length }],
    mediaSrc: "media/notes.png",
    designSourceMdSha256: inputSha256("design.md"),
    designSourceJsonSha256: inputSha256("design.json"),
  };
  const checked = verifiedAttachment("notes", { ...body, ...extra });
  assert.deepEqual(verifiedAttachment("notes", checked), checked);
  const material = toMaterialAttachment(checked);
  assert.ok(material);
  assert.equal(material.parser, "text-utf8-v1");
  assert.equal(material.text, mdText);
  const { parts, mediaSrc, designSourceMdSha256, designSourceJsonSha256 } = material;
  assert.deepEqual({ parts, mediaSrc, designSourceMdSha256, designSourceJsonSha256 }, extra);

  const raw = writeAttachment(host.dataRoot, "appendix", fixtures.long);
  const appendix = verifiedAttachment("appendix", raw);
  assert.deepEqual(verifiedAttachment("appendix", appendix), appendix);
  assert.equal(appendix.text, undefined);
  assert.equal(toMaterialAttachment(appendix)?.summaryZh, "解析摘要 appendix.txt");
  for (const patch of [
    { status: "rejected" },
    { ownerId: "user-2" },
    { clipped: true },
    { truncated: true },
    { derivativeSha256: "invalid" },
    { parser: " " },
    { kind: "unknown" },
    { bytes: 0 },
  ])
    assert.throws(() => verifiedAttachment("appendix", { ...raw, ...patch }), /receipt/);
});

test("create delivers mixed Office, PDF, image and inline materials to the model and material tools", async (t) => {
  const host = testHost(t, true);
  const ids = host.upload("docx", "xlsx", "pdf", "image", "csv", "md");
  const { root, sessionId } = await host.accepted(await host.create(ids));
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(root, "_agent", "generation-input.v1.json"), "utf8"),
  ) as GenerationInputSnapshot;
  const prompt = actualTurn(host.requests[0]);
  assert.equal(prompt, snapshot.initialMessage);
  assert.match(prompt, /<reference_materials>/);
  assert.match(prompt, /list_materials, read_material, view_material/);
  assert.match(prompt, /"mediaSrc":"media\//);
  const manifest = readMaterialsManifest(root);
  assert.deepEqual(
    manifest.materials.map(({ id }) => id),
    ids,
  );
  for (const attachment of snapshot.attachments) {
    const material = toMaterialAttachment(attachment);
    assert.ok(material);
    const delivered =
      attachment.text === undefined
        ? JSON.stringify(materialManifestEntry(material))
        : JSON.stringify({ id: attachment.id, name: attachment.name, text: attachment.text });
    assert.ok(prompt.includes(delivered), attachment.id);
    assert.equal(attachment.contentBlockSha256, inputSha256(delivered));
  }
  assert.match(
    buildDiskContextSummary(root),
    /已上传资料：report\.docx、workbook\.xlsx.*inventory\.md（可用 list_materials \/ read_material 查阅）/,
  );

  const list = await host.read(sessionId, root, "list_materials");
  assert.equal(list.ok, true, list.detail);
  assert.equal(list.summary, "6 uploaded materials");
  for (const [id, evidence] of [
    ["docx", /172/],
    ["xlsx", /212/],
    ["pdf", /481/],
    ["csv", /North\s+84/],
    ["md", /317/],
    ["image", /PNG/],
  ] as const) {
    const result = await host.read(sessionId, root, "read_material", { materialId: id });
    assert.equal(result.ok, true, result.detail);
    assert.match(String(result.payload.text), evidence, id);
  }
  const query = await host.read(sessionId, root, "query_material", {
    materialId: "csv",
    measures: [{ op: "sum", column: "Price", as: "total" }],
  });
  assert.equal(query.ok, true, query.detail);
  assert.deepEqual(query.payload.rows, [[108]]);
  const facts = readRunLedger(root)?.facts ?? [];
  const readIds = facts.flatMap((fact) => (fact.type === "material.chunk-returned" ? [fact.materialId] : []));
  assert.ok(readIds.includes("csv") && readIds.includes("md"));
  assert.ok(
    facts.some((fact) => fact.type === "material.query-computed" && fact.resultSha256 === query.payload.resultSha256),
  );
});

test("a discussion session delivers large text and a PPTX template without adding inline text", async (t) => {
  const host = testHost(t);
  const ids = host.upload("long", "pptx");
  const { sessionId, root } = await host.accepted(await host.create(ids, { conversationMode: "discuss" }));
  const first = actualTurn(host.requests.at(-1));
  assert.match(first, /<reference_materials>/);
  assert.doesNotMatch(first, /<editor_attachments>\n|Appendix starts here/);
  assert.ok(first.length < 48_000);
  assert.deepEqual(
    readMaterialsManifest(root).materials.map(({ id }) => id),
    ids,
  );
  const { attachments } = JSON.parse(
    fs.readFileSync(path.join(root, "_agent", "generation-input.v1.json"), "utf8"),
  ) as GenerationInputSnapshot;
  const template = attachments.find(({ id }) => id === "pptx");
  assert.ok(template?.designSourceMdSha256 && template.designSourceJsonSha256);
  assert.ok(first.includes(attachmentDeliveryBlock(template)));
  const offered = host.requests.at(-1)?.tools?.map(({ name }) => name) ?? [];
  for (const tool of materialsTools) assert.ok(offered.includes(tool), tool);
  assert.ok(!offered.includes("write_page"));
  const read = await host.read(sessionId, root, "read_material", { materialId: "long" });
  assert.equal(read.ok, true, read.detail);
  assert.match(String(read.payload.text), /Appendix starts here/);
});

test("a follow-up unlocks the material tools for an existing empty session before the model sees the turn", async (t) => {
  const host = testHost(t);
  const { root, sessionId } = await host.accepted(await host.create([]));
  assert.equal(readMaterialsManifest(root).materials.length, 0);
  assert.ok(!host.requests[0]?.tools?.some(({ name }) => name === "read_material"));

  const ids = host.upload("docx", "xlsx", "pdf", "image");
  await host.accepted(await host.turn(sessionId, ids));
  const request = host.requests.at(-1);
  const prompt = actualTurn(request);
  assert.match(prompt, /<reference_materials>/);
  assert.doesNotMatch(prompt, /<editor_attachments>\n|view_material/);
  assert.deepEqual(
    readMaterialsManifest(root).materials.map(({ id }) => id),
    ids,
  );
  for (const tool of materialsTools)
    assert.ok(
      request?.tools?.some(({ name }) => name === tool),
      tool,
    );
  const turnAttachments = fs.readFileSync(path.join(root, "_agent", "turn-attachments.v1.json"), "utf8");
  assert.match(turnAttachments, /workbook\.xlsx/);
  const query = await host.read(sessionId, root, "query_material", {
    materialId: "xlsx",
    measures: [{ op: "sum", column: "Price", as: "total" }],
  });
  assert.equal(query.ok, true, query.detail);
  assert.deepEqual(query.payload.rows, [[212]]);
});

test("busy steering persists the accepted material before the live runtime receives the prompt", async (t) => {
  const host = testHost(t);
  const { root, sessionId } = await host.accepted(await host.create([]));
  const attachments = host.upload("docx");
  let steered = false;
  host.runtime.agentBusy = () => true;
  host.runtime.getAgent = () => ({
    followup: () => assert.fail("steering cannot start a separate turn"),
    steer(message) {
      assert.deepEqual(
        readMaterialsManifest(root).materials.map(({ id }) => id),
        attachments,
      );
      assert.match(message.content[0]?.text ?? "", /<reference_materials>[\s\S]*report\.docx/);
      steered = true;
    },
  });
  const response = await invokeSlides(host.runtime, "POST", `/slides/sessions/${sessionId}/turn`, {
    text: "Use this report too",
    steer: true,
    attachments,
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.ok(steered);
});

for (const [sidecar, tamper] of [
  ["original", (file: string) => fs.appendFileSync(file, "!")],
  ["derivative", (file: string) => fs.appendFileSync(`${file}.derivative.json`, " ")],
  ["missing original", (file: string) => fs.unlinkSync(file)],
] as const) {
  test(`${sidecar} tampering returns HTTP 400 before creating a project or starting a turn`, async (t) => {
    const host = testHost(t);
    const ids = host.upload("docx", "md");
    tamper(path.join(attachmentsStoreDir(host.dataRoot), "docx"));
    const create = await host.create(ids);
    assert.equal(create.status, 400, JSON.stringify(create.json));
    assert.equal((create.json as { code: string }).code, "invalid_generation_input");
    assert.equal(fs.existsSync(host.runtime.store.slicesRoot()), false);
    assert.equal(host.requests.length, 0);

    const { root, sessionId } = await host.accepted(await host.create([]));
    const turn = await host.turn(sessionId, ids);
    assert.equal(turn.status, 400, JSON.stringify(turn.json));
    assert.equal((turn.json as { code: string }).code, "invalid_attachment");
    assert.equal(host.requests.length, 1);
    assert.equal(host.busy.size, 0);
    assert.equal(readMaterialsManifest(root).materials.length, 0);
    assert.ok(!fs.existsSync(path.join(root, "_agent", "turn-attachments.v1.json")));
  });
}

test("session creation rechecks disk after route verification and before opening a project", async (t) => {
  const host = testHost(t);
  const ids = host.upload("pdf");
  const createAgent = host.runtime.createAgent;
  host.runtime.createAgent = (input) => {
    fs.appendFileSync(path.join(attachmentsStoreDir(host.dataRoot), "pdf.derivative.json"), " ");
    return createAgent(input);
  };
  const response = await host.create(ids);
  assert.equal(response.status, 400, JSON.stringify(response.json));
  assert.equal((response.json as { code: string }).code, "invalid_generation_input");
  assert.equal(fs.existsSync(host.runtime.store.slicesRoot()), false);
  assert.equal(host.requests.length, 0);
});
