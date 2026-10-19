import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

function textElement(id, text) {
  return {
    elementId: id,
    elementType: "text",
    bounds: [80, 80, 800, 60],
    content: { text, fontSize: 32 },
  };
}

function writeTwoPageProject(root, firstText, secondText) {
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deck.pptd"),
    `${JSON.stringify({
      version: "v2",
      title: path.basename(root),
      size: [960, 540],
      theme: {},
      pages: ["pages/01_page.page", "pages/02_page.page"],
    })}\n`,
  );
  for (const [name, text] of [
    ["01_page", firstText],
    ["02_page", secondText],
  ]) {
    fs.writeFileSync(
      path.join(root, "pages", `${name}.page`),
      `${JSON.stringify({
        pageType: "content",
        elements: [textElement(`${name}-title`, text)],
      })}\n`,
    );
  }
  fs.mkdirSync(path.join(root, "media"), { recursive: true });
}

const { server } = await import("./server.mjs");

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openkimi-concurrency-"));
  roots.push(root);
  return root;
}

async function httpEndpoint() {
  if (!server.listening) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function openProject(base, root, page = 0) {
  const res = await fetch(`${base}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: root, page }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function command(base, root, cmd) {
  const res = await fetch(`${base}/api/command?project=${encodeURIComponent(root)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  assert.equal(
    res.status,
    200,
    await res
      .clone()
      .text()
      .catch(() => ""),
  );
  return res.json();
}

async function model(base, root) {
  const res = await fetch(`${base}/api/model?project=${encodeURIComponent(root)}`);
  assert.equal(res.status, 200);
  return res.json();
}

after(() => {
  try {
    server.close();
  } catch {
    // already closed
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("concurrent project sessions", () => {
  it("keeps live sessions separate when two projects interleave open and commands", async () => {
    const base = await httpEndpoint();
    const rootA = fixture();
    const rootB = fixture();
    writeTwoPageProject(rootA, "A one", "A two");
    writeTwoPageProject(rootB, "B one", "B two");

    await openProject(base, rootA);
    await openProject(base, rootB);
    // A request that names no project falls back to the last opened one (B).
    // A request that names A must still land on A: this is the exact race the
    // shared singleton lost.
    const moved = await command(base, rootA, { cmd: "goToPage", index: 1 });
    assert.equal(moved.model.pageIndex, 1);

    const seenA = await model(base, rootA);
    const seenB = await model(base, rootB);
    assert.equal(seenA.model.pageIndex, 1);
    assert.equal(seenB.model.pageIndex, 0);
    assert.match(JSON.stringify(seenA.model.elements), /A two/);
    assert.match(JSON.stringify(seenB.model.elements), /B one/);
  });

  it("reloads a live session after an external project change", async () => {
    const base = await httpEndpoint();
    const root = fixture();
    writeTwoPageProject(root, "Before disk edit", "Second page");
    await openProject(base, root);

    const pagePath = path.join(root, "pages", "01_page.page");
    const page = JSON.parse(fs.readFileSync(pagePath, "utf8"));
    page.elements[0].content.text = "After disk edit";
    fs.writeFileSync(pagePath, `${JSON.stringify(page)}\n`);

    const loaded = await model(base, root);
    assert.match(JSON.stringify(loaded.model.elements), /After disk edit/);
  });

  it("serves media from the requested project, not the last opened one", async () => {
    const base = await httpEndpoint();
    const rootA = fixture();
    const rootB = fixture();
    writeTwoPageProject(rootA, "A one", "A two");
    writeTwoPageProject(rootB, "B one", "B two");
    fs.writeFileSync(path.join(rootA, "media", "photo.png"), "bytes-from-A");
    fs.writeFileSync(path.join(rootB, "media", "photo.png"), "bytes-from-B");

    await openProject(base, rootA);
    await openProject(base, rootB);

    const fromA = await fetch(`${base}/media/media/photo.png?project=${encodeURIComponent(rootA)}`);
    const fromB = await fetch(`${base}/media/media/photo.png?project=${encodeURIComponent(rootB)}`);
    assert.equal(fromA.status, 200);
    assert.equal(fromB.status, 200);
    assert.equal(await fromA.text(), "bytes-from-A");
    assert.equal(await fromB.text(), "bytes-from-B");
  });
});
