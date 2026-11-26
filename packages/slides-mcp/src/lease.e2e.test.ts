import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPresentationRun, runDomainHand } from "@open-slidestudio/presentation-run";
import { prepareFixturePageImage } from "@open-slidestudio/presentation-run/testkit";
import {
  acquireProjectLease,
  readProjectLease,
  releaseProjectLease,
  withProjectLeaseLock,
} from "@open-slidestudio/slides-tools";
import { mcpProjectPort, type McpSessionState } from "./project-port.js";
import { createSlidesMcpServer } from "./server.js";
import { SessionClient, tempDir, toolData, waitFor } from "./testkit.js";

process.env.SLIDESTUDIO_PLAYWRIGHT_RUNTIME = "/nonexistent/slides-mcp-test/runtime.mjs";

const EDITOR = { kind: "editor-human" as const, ownerId: "editor-human:tab-1", label: "editor tab" };

function setup() {
  const dataRoot = tempDir("lease-data");
  const inputs = tempDir("lease-inputs");
  fs.writeFileSync(path.join(inputs, "a.md"), "# 第一版\n");
  fs.writeFileSync(path.join(inputs, "b.md"), "# 第二版\n");
  const server = createSlidesMcpServer({ dataRoot, allowedImportRoots: [inputs], log: () => undefined });
  return { dataRoot, inputs, server };
}

test("editor preemption: MCP writes fail closed until the editor releases and MCP re-acquires explicitly", async () => {
  const { dataRoot, inputs, server } = setup();
  const mcp = new SessionClient(server.createSession());
  await mcp.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "agent" } });
  const opened = toolData(await mcp.call("open_project", { title: "抢占" }));
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));
  assert.equal(readProjectLease(root).holder?.ownerId, mcp.session.state.callerId);

  const preempt = acquireProjectLease(root, EDITOR);
  assert.equal(preempt.ok && preempt.outcome, "preempted");

  const blocked = await mcp.call("import_material", { path: path.join(inputs, "a.md") });
  assert.equal(blocked.isError, true);
  assert.equal(toolData(blocked).outcome, "lease-preempted-by-editor");
  assert.equal(fs.existsSync(path.join(root, "_agent", "materials", "manifest.json")), false, "nothing was written");

  const early = await mcp.call("reacquire_lease");
  assert.equal(early.isError, true);
  assert.equal(toolData(early).outcome, "lease-preempted-by-editor", "the editor still holds the project");
  assert.equal((toolData(early).holder as { kind: string }).kind, "editor-human");

  assert.equal(releaseProjectLease(root, EDITOR.ownerId), true);
  const implicit = await mcp.call("import_material", { path: path.join(inputs, "a.md") });
  assert.equal(implicit.isError, true);
  assert.equal(toolData(implicit).outcome, "lease-preempted-by-editor", "an implicit write never re-acquires");

  const recovered = await mcp.call("reacquire_lease");
  assert.equal(recovered.isError, undefined, JSON.stringify(recovered));
  assert.match(String(toolData(recovered).next), /read_page/);
  assert.equal(readProjectLease(root).holder?.ownerId, mcp.session.state.callerId);

  const written = await mcp.call("import_material", { path: path.join(inputs, "b.md") });
  assert.equal(written.isError, undefined, JSON.stringify(written));
  assert.equal(toolData(written).outcome, "imported");

  mcp.session.close();
  assert.equal(readProjectLease(root).holder, undefined);
});

test("bind_project refuses a project another writer holds and leaves the disk unchanged", async () => {
  const { dataRoot, server } = setup();
  const owner = new SessionClient(server.createSession());
  await owner.request("initialize", { protocolVersion: "2025-03-26" });
  const opened = toolData(await owner.call("open_project", { title: "占用" }));
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));
  const runFile = path.join(root, "_agent", "presentation-run.v1.json");
  const before = fs.readFileSync(runFile, "utf8");

  const other = new SessionClient(server.createSession());
  await other.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "second" } });
  const refused = await other.call("bind_project", { projectId: opened.projectId });
  assert.equal(refused.isError, true);
  assert.equal(toolData(refused).outcome, "lease-conflict");
  assert.equal(other.session.state.binding, undefined);
  assert.equal(fs.readFileSync(runFile, "utf8"), before, "the run binding was not rewritten");
  assert.equal(readProjectLease(root).holder?.ownerId, owner.session.state.callerId);

  other.session.close();
  assert.equal(
    readProjectLease(root).holder?.ownerId,
    owner.session.state.callerId,
    "closing never drops a foreign lease",
  );

  owner.session.close();
  const third = new SessionClient(server.createSession());
  assert.equal(toolData(await third.call("bind_project", { projectId: opened.projectId })).outcome, "bound");
  third.session.close();
});

test("bind_project continues a closed session's project on the same run and switches the provider label", async () => {
  const { dataRoot, server } = setup();
  const first = new SessionClient(server.createSession());
  await first.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "first" } });
  const opened = toolData(await first.call("open_project", { title: "接续" }));
  const firstRun = first.session.state.binding?.runSessionId;
  first.session.close();

  const second = new SessionClient(server.createSession());
  await second.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "second" } });
  const bound = toolData(await second.call("bind_project", { projectId: opened.projectId }));
  assert.equal(bound.outcome, "bound");
  assert.equal(bound.projectRoot, opened.projectRoot);
  assert.match(String(bound.next), /read_page/);
  assert.equal(second.session.state.binding?.runSessionId, firstRun, "receipts stay on the project's run");
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));
  const run = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"));
  assert.equal(run.provider.modelId, "second");
  const reopened = toolData(await second.call("open_project", { title: "接续" }));
  assert.equal(reopened.outcome, "reopened");
  second.session.close();
  assert.equal(readProjectLease(root).holder, undefined);
});

test("import_material re-verifies the writer lease inside the lock before writing materials", async () => {
  const { dataRoot, inputs, server } = setup();
  const notePath = path.join(inputs, "notes.md");
  fs.writeFileSync(notePath, "# Preemption probe\n");
  const mcp = new SessionClient(server.createSession());
  const opened = toolData(await mcp.call("open_project", { title: "导入抢占测试" }));
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));

  // Preempt the MCP lease right while import_material is reading the local file,
  // after the upfront lease gate already passed.
  const origOpen = fs.openSync;
  let preemptedOnce = false;
  fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (!preemptedOnce && String(target) === fs.realpathSync(notePath)) {
      preemptedOnce = true;
      const take = acquireProjectLease(root, { kind: "editor-human", ownerId: "editor-human:race-tab" });
      assert.equal(take.ok && take.outcome, "preempted");
    }
    return origOpen(target, flags, mode as never);
  }) as typeof fs.openSync;
  try {
    const res = await mcp.call("import_material", { path: notePath });
    assert.equal(res.isError, true);
    assert.equal(toolData(res).outcome, "lease-preempted-by-editor");
    assert.equal(preemptedOnce, true);
    assert.equal(fs.existsSync(path.join(root, "_agent", "materials", "manifest.json")), false);
  } finally {
    fs.openSync = origOpen;
    mcp.session.close();
  }
});

function snapshotProjectFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".pptd-write.lock" || entry.name === "writer-lease.v1.json" || entry.name === "holder.ready") {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

test("write_page refuses with zero file mutations when editor-human preempts while waiting for the project write lock", async () => {
  const { dataRoot, server } = setup();
  const mcp = new SessionClient(server.createSession());
  await mcp.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "writer" } });
  const opened = toolData(await mcp.call("open_project", { title: "写锁抢占" }));
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));

  const refs = toolData(await mcp.call("list_references"));
  const missing = (refs.payload as { missingReferenceChunks: { sourceId: string; chunkIndex: number }[] })
    .missingReferenceChunks;
  for (const chunk of missing) await mcp.call("read_reference", chunk);
  const plan = [
    { pageId: "p01", title: "第一页", layoutFamily: "content", exhibits: [] as string[], purpose: "cover" },
  ];
  assert.equal(toolData(await mcp.call("commit_design", { slidePlan: plan })).outcome, "committed");
  assert.equal(
    toolData(
      await mcp.call("write_todo", {
        items: [{ pageId: "p01", title: "第一页", layoutFamily: "content", exhibits: ["none"] }],
      }),
    ).outcome,
    "committed",
  );

  const before = snapshotProjectFiles(root);
  const readyFlag = path.join(root, "holder.ready");
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Hold the cross-process project write lock in a child process, let MCP pass
  // its upfront lease check and queue behind the lock, then preempt the lease
  // as editor-human before releasing the write lock.
  const holderScript = `
    import fs from "node:fs";
    const { withProjectWriteLock } = await import("@open-slidestudio/pptd-v2");
    const { acquireProjectLease } = await import("@open-slidestudio/slides-tools");
    withProjectWriteLock(process.env.HOLD_ROOT, () => {
      fs.writeFileSync(process.env.HOLD_FLAG, "locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      const res = acquireProjectLease(process.env.HOLD_ROOT, {
        kind: "editor-human",
        ownerId: "editor-human:lock-wait-race",
        label: "editor race",
      });
      if (!res.ok || res.outcome !== "preempted") throw new Error(JSON.stringify(res));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holderScript], {
    cwd: pkgRoot,
    env: { ...process.env, HOLD_ROOT: root, HOLD_FLAG: readyFlag },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let holderStderr = "";
  child.stderr.on("data", (d: Buffer) => {
    holderStderr += d.toString("utf8");
  });
  const childExit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
  try {
    await waitFor(() => fs.existsSync(readyFlag), 10_000);
    const writeRes = await mcp.call("write_page", {
      id: "p01",
      pageType: "content",
      elements: [
        {
          elementId: "title",
          elementType: "text",
          bounds: [80, 120, 800, 70],
          content: { text: "不应写入的标题", fontSize: 32, color: "#1F2937" },
        },
        {
          elementId: "body",
          elementType: "text",
          bounds: [80, 220, 800, 160],
          content: { text: "抢占后不得修改任何项目文件。", fontSize: 24, color: "#1F2937" },
        },
      ],
    });
    assert.equal(await childExit, 0, holderStderr);
    assert.equal(writeRes.isError, true, JSON.stringify(writeRes));
    assert.equal(toolData(writeRes).outcome, "lease-preempted-by-editor");
    assert.deepEqual(snapshotProjectFiles(root), before, "no deck, page, ledger or receipt file changed");
    assert.equal(readProjectLease(root).holder?.ownerId, "editor-human:lock-wait-race");
  } finally {
    fs.rmSync(readyFlag, { force: true });
    mcp.session.close();
  }
});

test("first open_project publishes atomically with lease/runtime intact and rollback never deletes an editor-held dir", async () => {
  const { dataRoot, server } = setup();
  const mcp = new SessionClient(server.createSession());
  await mcp.request("initialize", { protocolVersion: "2025-03-26" });
  const opened = toolData(await mcp.call("open_project", { title: "原子发布" }));
  const slices = path.join(dataRoot, "output", "dsh-slices");
  assert.deepEqual(
    fs.readdirSync(slices).filter((name) => name.startsWith(".staging-")),
    [],
    "no hidden staging directory remains after open_project",
  );
  const root = path.join(slices, String(opened.projectId));
  assert.equal(fs.existsSync(path.join(root, "deck.pptd")), true);
  assert.equal(fs.existsSync(path.join(root, "_agent", "runtime.json")), true);
  assert.equal(fs.existsSync(path.join(root, "_agent", "run-ledger.v1.json")), true);
  assert.equal(readProjectLease(root).holder?.ownerId, mcp.session.state.callerId);

  // If editor-human now holds the directory's lease, rollbackCreated must never delete it.
  const taken = acquireProjectLease(root, EDITOR);
  assert.equal(taken.ok && taken.outcome, "preempted");
  const state: McpSessionState = {
    sessionId: mcp.session.id,
    callerId: mcp.session.state.callerId,
    label: "agent",
    acceptsImages: true,
    binding: mcp.session.state.binding,
    leasedRoots: new Set([root]),
  };
  const port = mcpProjectPort(
    { dataRoot, editorBaseUrl: "http://127.0.0.1:9", presentation: createPresentationRun() },
    state,
  );
  port.rollbackCreated?.(root, {
    projectId: String(opened.projectRoot),
    projectRoot: root,
    callId: "rb-1",
    caller: { kind: "mcp", id: state.callerId },
  });
  assert.equal(fs.existsSync(path.join(root, "deck.pptd")), true, "editor-held project survived rollback");
  assert.equal(state.binding, undefined);
  assert.equal(state.leasedRoots.size, 0);
  mcp.session.close();
});

test("tool receipts and _mark_image_emitted ledger updates hold both locks and fail closed on preemption", async () => {
  const { dataRoot, server } = setup();
  const mcp = new SessionClient(server.createSession());
  await mcp.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "lock-audit" } });
  const opened = toolData(await mcp.call("open_project", { title: "锁边界" }));
  const root = path.join(dataRoot, "output", "dsh-slices", String(opened.projectId));

  const refs = toolData(await mcp.call("list_references"));
  const missing = (refs.payload as { missingReferenceChunks: { sourceId: string; chunkIndex: number }[] })
    .missingReferenceChunks;
  for (const chunk of missing) await mcp.call("read_reference", chunk);
  const plan = [
    { pageId: "p01", title: "锁边界", layoutFamily: "content", exhibits: [] as string[], purpose: "cover" },
  ];
  assert.equal(toolData(await mcp.call("commit_design", { slidePlan: plan })).outcome, "committed");

  const receiptFile = path.join(root, "_agent", "dsh-tool-receipts.v1.json");
  let receiptLocks: { outer: boolean; inner: boolean } | undefined;
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = ((
    target: fs.PathOrFileDescriptor,
    data: string | NodeJS.ArrayBufferView,
    opts?: fs.WriteFileOptions,
  ) => {
    if (String(target) === receiptFile) {
      receiptLocks = {
        outer: fs.existsSync(path.join(root, ".pptd-write.lock")),
        inner: fs.existsSync(path.join(root, "_agent", ".pptd-write.lock")),
      };
    }
    return origWrite(target, data as never, opts as never);
  }) as typeof fs.writeFileSync;
  try {
    const written = toolData(
      await mcp.call("write_page", {
        id: "p01",
        pageType: "content",
        elements: [
          {
            elementId: "title",
            elementType: "text",
            bounds: [80, 120, 800, 70],
            content: { text: "锁边界标题", fontSize: 32, color: "#1F2937" },
          },
          {
            elementId: "body",
            elementType: "text",
            bounds: [80, 220, 800, 160],
            content: { text: "核验工具回执与图片送达账本均位于两层锁内。", fontSize: 24, color: "#1F2937" },
          },
        ],
      }),
    );
    assert.equal(written.outcome, "written");
  } finally {
    fs.writeFileSync = origWrite;
  }
  assert.deepEqual(receiptLocks, { outer: true, inner: true }, "tool receipt write must hold both locks");

  // Verify _mark_image_emitted holds both locks and respects preemption.
  const epoch = JSON.parse(fs.readFileSync(path.join(root, "_agent", "presentation-run.v1.json"), "utf8"))
    .contextEpochId as string;
  const deliveryToken = prepareFixturePageImage(root, "p01", { commandId: "prep-1", contextEpochId: epoch });
  const ledgerFile = path.join(root, "_agent", "run-ledger.v1.json");
  let emitLocks: { outer: boolean; inner: boolean } | undefined;
  const origRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === ledgerFile) {
      emitLocks = {
        outer: fs.existsSync(path.join(root, ".pptd-write.lock")),
        inner: fs.existsSync(path.join(root, "_agent", ".pptd-write.lock")),
      };
    }
    return origRename(from, to);
  }) as typeof fs.renameSync;
  const authorize = <T>(commit: () => T) =>
    withProjectLeaseLock(root, () => {
      const lease = acquireProjectLease(root, { kind: "mcp", ownerId: mcp.session.state.callerId });
      if (!lease.ok) {
        return {
          ok: false as const,
          summary: lease.outcome,
          detail: lease.detail,
          payload: { ok: false, outcome: lease.outcome, error: lease.outcome, detail: lease.detail },
        };
      }
      return { ok: true as const, value: commit() };
    });
  try {
    const emitted = await runDomainHand(
      "_mark_image_emitted",
      { deliveryToken, __openSlideStudio: { commandId: "emit-1", contextEpochId: epoch } },
      root,
      { runAuthorizedWrite: authorize },
    );
    assert.equal(emitted.ok, true, JSON.stringify(emitted));
  } finally {
    fs.renameSync = origRename;
  }
  assert.deepEqual(emitLocks, { outer: true, inner: true }, "_mark_image_emitted must hold both locks");

  // Once editor-human preempts, a subsequent _mark_image_emitted refuses without modifying the ledger.
  const preempted = acquireProjectLease(root, EDITOR);
  assert.equal(preempted.ok && preempted.outcome, "preempted");
  const ledgerBefore = fs.readFileSync(ledgerFile, "utf8");
  const blocked = await runDomainHand(
    "_mark_image_emitted",
    { deliveryToken, __openSlideStudio: { commandId: "emit-2", contextEpochId: epoch } },
    root,
    { runAuthorizedWrite: authorize },
  );
  assert.equal(blocked.ok, false);
  assert.equal((blocked.payload as { outcome?: string }).outcome, "lease-preempted-by-editor");
  assert.equal(
    fs.readFileSync(ledgerFile, "utf8"),
    ledgerBefore,
    "preempted _mark_image_emitted must not touch ledger",
  );
  mcp.session.close();
});
