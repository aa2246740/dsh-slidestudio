import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openslides-command-persist-"));
const pageFile = path.join(projectRoot, "pages", "01_page.page");
const pagesDirectory = path.dirname(pageFile);
fs.mkdirSync(pagesDirectory, { recursive: true });
fs.writeFileSync(
  path.join(projectRoot, "deck.pptd"),
  `${JSON.stringify({
    version: "v2",
    title: "Command transaction",
    size: [960, 540],
    pages: ["pages/01_page.page"],
  })}\n`,
);
fs.writeFileSync(
  pageFile,
  `${JSON.stringify({
    pageType: "content",
    elements: [
      {
        elementId: "title",
        elementType: "text",
        bounds: [80, 80, 800, 60],
        content: { text: "Before", fontSize: 32 },
      },
    ],
  })}\n`,
);

process.env.OPEN_SLIDESTUDIO_PROJECT = projectRoot;
const { server } = await import("./server.mjs");
const { loadProject } = await import("../../../packages/pptd-v2/dist/index.js");

/** @type {(() => void) | undefined} */
let restorePagesOpen;

/** @param {boolean} writable */
function setPagesDirectoryWritable(writable) {
  if (process.platform === "win32") {
    if (!writable) {
      const openSync = fs.openSync.bind(fs);
      /** @type {typeof fs.openSync} */
      const injectOpenFailure = (file, ...args) => {
        if (typeof file === "string") {
          const relative = path.relative(pagesDirectory, path.resolve(file));
          if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
            throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), {
              errno: -4048,
              code: "EPERM",
              syscall: "open",
              path: file,
            });
          }
        }
        return openSync(file, ...args);
      };
      const mockedOpen = mock.method(fs, "openSync", injectOpenFailure);
      restorePagesOpen = () => mockedOpen.mock.restore();
    } else if (restorePagesOpen) {
      restorePagesOpen();
      restorePagesOpen = undefined;
    }
    return;
  }
  fs.chmodSync(pagesDirectory, writable ? 0o755 : 0o555);
}

async function endpoint() {
  if (!server.listening) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  }
  return `http://127.0.0.1:${server.address().port}`;
}

async function command(base, body) {
  const response = await fetch(`${base}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

after(async () => {
  setPagesDirectoryWritable(true);
  if (process.platform !== "win32") fs.chmodSync(pageFile, 0o644);
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("native command persistence transaction", { concurrency: false }, () => {
  it("keeps the prior live model after a disk write failure and lets the same selection retry", async () => {
    const base = await endpoint();
    assert.equal((await command(base, { cmd: "select", elementId: "title" })).response.status, 200);

    // Establish the immutable baseline before making the pages directory
    // Establish the baseline before blocking opens of the atomic sibling temp file.
    assert.equal((await command(base, { cmd: "setText", text: "Before" })).response.status, 200);
    const failed = await (async () => {
      setPagesDirectoryWritable(false);
      try {
        if (process.platform === "win32") {
          assert.throws(() => fs.openSync(path.join(pagesDirectory, "probe.tmp"), "w"), { code: "EPERM" });
        }
        return await command(base, { cmd: "setText", text: "Must not leak" });
      } finally {
        setPagesDirectoryWritable(true);
      }
    })();
    assert.equal(failed.response.status, 400);
    assert.match(failed.body.error, /EACCES|EPERM|permission denied|operation not permitted/i);
    assert.equal(failed.body.model.elements.find((element) => element.id === "title")?.text, "Before");
    assert.equal(failed.body.model.selection.kind, "element");
    assert.equal(failed.body.model.selection.elementId, "title");
    assert.equal(loadProject(projectRoot).pages[0].page.elements[0].content.text, "Before");

    const retried = await command(base, { cmd: "setText", text: "After retry" });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.model.elements.find((element) => element.id === "title")?.text, "After retry");
    assert.equal(loadProject(projectRoot).pages[0].page.elements[0].content.text, "After retry");

    const undone = await command(base, { cmd: "undo" });
    assert.equal(undone.response.status, 200);
    assert.equal(undone.body.model.elements.find((element) => element.id === "title")?.text, "Before");
    const redone = await command(base, { cmd: "redo" });
    assert.equal(redone.response.status, 200);
    assert.equal(redone.body.model.elements.find((element) => element.id === "title")?.text, "After retry");

    const legacyNotes = await command(base, { cmd: "setNotes", notes: "current-page notes" });
    assert.equal(legacyNotes.response.status, 200);
    assert.equal(legacyNotes.body.model.notes, "current-page notes");
  });

  it("inserts supplied plain text in one persisted command and rejects invalid text without disk changes", async () => {
    const base = await endpoint();
    const inserted = await command(base, { cmd: "insert", kind: "text", text: "外部剪贴板文本" });
    assert.equal(inserted.response.status, 200);
    const created = inserted.body.model.elements.at(-1);
    assert.equal(created.type, "text");
    assert.equal(created.text, "外部剪贴板文本");
    const persisted = fs.readFileSync(pageFile, "utf8");
    assert.equal(loadProject(projectRoot).pages[0].page.elements.at(-1).content.text, "外部剪贴板文本");

    const wrongType = await command(base, { cmd: "insert", kind: "text", text: 42 });
    assert.equal(wrongType.response.status, 400);
    assert.equal(wrongType.body.code, "INVALID_INSERT_TEXT");
    assert.equal(fs.readFileSync(pageFile, "utf8"), persisted);

    const tooLong = await command(base, { cmd: "insert", kind: "text", text: "x".repeat(20_001) });
    assert.equal(tooLong.response.status, 400);
    assert.equal(tooLong.body.code, "INSERT_TEXT_TOO_LONG");
    assert.equal(tooLong.body.maxLength, 20_000);
    assert.equal(fs.readFileSync(pageFile, "utf8"), persisted);
  });

  it("inserts requested table dimensions atomically and rejects invalid sizes", async () => {
    const base = await endpoint();
    const beforeInvalid = fs.readFileSync(pageFile, "utf8");

    const fractional = await command(base, { cmd: "insert", kind: "table", rows: 1.5, columns: 2 });
    assert.equal(fractional.response.status, 400);
    assert.match(fractional.body.error, /rows must be an integer/);
    assert.equal(fs.readFileSync(pageFile, "utf8"), beforeInvalid);

    const tooLarge = await command(base, { cmd: "insert", kind: "table", rows: 2, columns: 7 });
    assert.equal(tooLarge.response.status, 400);
    assert.match(tooLarge.body.error, /columns must be between 1 and 6/);
    assert.equal(fs.readFileSync(pageFile, "utf8"), beforeInvalid);

    const defaultTable = await command(base, { cmd: "insert", kind: "table" });
    assert.equal(defaultTable.response.status, 200);
    assert.equal(defaultTable.body.model.elements.at(-1).tableRows.length, 2);
    assert.equal(defaultTable.body.model.elements.at(-1).tableRows[0].length, 2);
    assert.equal((await command(base, { cmd: "undo" })).response.status, 200);

    const one = await command(base, { cmd: "insert", kind: "table", rows: 1, columns: 1 });
    assert.equal(one.response.status, 200);
    const oneTable = one.body.model.elements.at(-1);
    assert.equal(oneTable.tableRows.length, 1);
    assert.equal(oneTable.tableRows[0].length, 1);
    assert.equal(oneTable.tableRows[0][0].text, "列 A");

    const undone = await command(base, { cmd: "undo" });
    assert.equal(undone.response.status, 200);
    assert.equal(
      undone.body.model.elements.some((element) => element.id === oneTable.id),
      false,
    );
    const redone = await command(base, { cmd: "redo" });
    assert.equal(redone.response.status, 200);
    assert.equal(redone.body.model.elements.find((element) => element.id === oneTable.id).tableRows.length, 1);

    const max = await command(base, { cmd: "insert", kind: "table", rows: 6, columns: 6 });
    assert.equal(max.response.status, 200);
    const maxTable = max.body.model.elements.at(-1);
    assert.equal(maxTable.tableRows.length, 6);
    assert.ok(maxTable.tableRows.every((row) => row.length === 6));
    assert.equal(maxTable.tableRows[0][5].text, "列 F");
    assert.equal(maxTable.tableRows[5][5].text, "—");
  });
});
