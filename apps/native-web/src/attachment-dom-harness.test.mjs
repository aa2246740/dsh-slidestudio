// Shared jsdom harness for the attachment UI tests (imported by the other
// attachment / editor / hub / vision DOM tests). It registers one self-test so the
// runner reports it like any other test file.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

/** @typedef {Window & typeof globalThis} DomWindow */
/** @typedef {(url: string, options?: RequestInit) => Promise<Response>} FetchImpl */

/** jsdom's constructor with the options the local declaration omits. */
const JSDOMWithOptions = /** @type {new (html: string, options?: {url?: string}) => {window: DomWindow}} */ (
  /** @type {unknown} */ (JSDOM)
);

/** XMLHttpRequest stand-in: records the request and lets the test drive every event. */
export class FakeXHR {
  /** @type {FakeXHR[]} */
  static instances = [];
  constructor() {
    FakeXHR.instances.push(this);
    /** @type {{onprogress?: (event: {lengthComputable: boolean, loaded: number, total: number}) => void, onload?: () => void}} */
    this.upload = {};
    /** @type {Record<string, string>} */
    this.requestHeaders = {};
    this.status = 0;
    this.responseText = "";
    this.aborted = false;
    /** Any terminal event fired (load, error, timeout, abort). */
    this.settled = false;
    this.timeout = 0;
    this.method = "";
    this.url = "";
    /** @type {unknown} */
    this.body = undefined;
    /** @type {(() => void) | undefined} */
    this.onload = undefined;
    /** @type {(() => void) | undefined} */
    this.onerror = undefined;
    /** @type {(() => void) | undefined} */
    this.ontimeout = undefined;
    /** @type {(() => void) | undefined} */
    this.onabort = undefined;
    /** @type {((event: {lengthComputable: boolean, loaded: number, total: number}) => void) | undefined} */
    this.onprogress = undefined;
  }
  /** @param {string} method @param {string} url */
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  /** @param {string} key @param {string} value */
  setRequestHeader(key, value) {
    this.requestHeaders[key] = value;
  }
  /** @param {unknown} body */
  send(body) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.settled = true;
    this.onabort?.();
  }
  /** @param {number} loaded @param {number} total */
  progress(loaded, total) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  /** @param {number} loaded @param {number} total */
  downloadProgress(loaded, total) {
    this.onprogress?.({ lengthComputable: true, loaded, total });
  }
  uploaded() {
    this.upload.onload?.();
  }
  networkError() {
    this.settled = true;
    this.onerror?.();
  }
  timedOut() {
    this.settled = true;
    this.ontimeout?.();
  }
  /** @param {number} status @param {unknown} payload */
  finish(status, payload) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.settled = true;
    this.onload?.();
  }
}

/** The nth recorded request; fails the test when it was never opened.
 * @param {number} index */
export function xhr(index) {
  const request = FakeXHR.instances[index];
  assert.ok(request, `XHR #${index} was opened`);
  return request;
}

/** Settles pending promise callbacks without touching (possibly mocked) setTimeout. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A File-shaped object the chip engine accepts.
 * @param {string} name @param {number} size @param {string} [type] @returns {File} */
export function fileLike(name, size, type = "") {
  return /** @type {File} */ (/** @type {unknown} */ ({ name, size, type }));
}

/** @param {string} key @param {unknown} value */
function defineGlobal(key, value) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/** Mount markup in a fresh jsdom and point the browser globals the modules use at it.
 * `restore()` puts every global back and closes the window.
 * @param {string} markup @param {{url?: string, fetchImpl?: FetchImpl}} [options] */
export function installDom(markup, { url = "http://editor.test/", fetchImpl } = {}) {
  const dom = new JSDOMWithOptions(markup, { url });
  const win = dom.window;
  const fetchMock = mock.fn(fetchImpl || (async () => new Response("{}", { status: 404 })));
  /** @type {Record<string, unknown>} */
  const values = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    DragEvent: win.DragEvent ?? class DragEvent extends win.Event {},
    location: win.location,
    localStorage: win.localStorage,
    XMLHttpRequest: FakeXHR,
    // Synchronous frames; returning 0 lets the engine schedule the next frame.
    requestAnimationFrame: (/** @type {() => void} */ callback) => {
      callback();
      return 0;
    },
    fetch: fetchMock,
  };
  const saved = Object.keys(values).map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
  }));
  for (const [key, value] of Object.entries(values)) defineGlobal(key, value);
  FakeXHR.instances = [];
  return {
    win,
    fetchMock,
    /** Swap the fetch implementation for the rest of the test.
     * @param {FetchImpl} impl */
    setFetch(impl) {
      const next = mock.fn(impl);
      defineGlobal("fetch", next);
      return next;
    },
    /** Let mount-time probes (health, models) settle, then put every global back. */
    async restore() {
      // Abort uploads a test left in flight so their stall watchdogs never outlive it.
      // A failed upload frees its slot a microtask later and the queue starts the next
      // file, so keep aborting until every request has settled.
      for (let round = 0; round < 40; round += 1) {
        for (const request of FakeXHR.instances) if (!request.settled) request.abort();
        await tick();
      }
      for (const { key, descriptor } of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      win.close();
    },
  };
}

/** URLs of every fetch call on a mock.
 * @param {{mock: {calls: {arguments: unknown[]}[]}}} fetchMock */
export function fetchedUrls(fetchMock) {
  return fetchMock.mock.calls.map((call) => String(call.arguments[0]));
}

/** @param {string} id */
export function required(id) {
  const element = document.getElementById(id);
  assert.ok(element, `#${id} exists`);
  return /** @type {HTMLElement} */ (element);
}

/** @param {ParentNode | null | undefined} root @param {string} selector */
export function query(root, selector) {
  const element = root?.querySelector(selector);
  assert.ok(element, `${selector} exists`);
  return /** @type {HTMLElement} */ (element);
}

/** Click a control inside a root.
 * @param {ParentNode | null | undefined} root @param {string} selector */
export function click(root, selector) {
  query(root, selector).click();
}

/** @param {ParentNode} root */
export function chipsIn(root) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(".reference-chip")]);
}

/** @param {Element | null | undefined} element */
export const textOf = (element) => element?.textContent || "";

/** @param {unknown} payload @param {number} [status] */
export const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

/** The Hub attach row, modal and close confirm hub-attachments.js mounts on. */
export const HUB_MARKUP = `
<main>
  <button id="btn-attach"></button>
  <button id="btn-attach-close"></button>
  <button id="btn-pick-files"></button>
  <button id="btn-demo-ref"></button>
  <div id="drop-zone" role="button" tabindex="0"></div>
  <input id="attach-file" type="file" multiple />
  <div id="attach-row"></div>
  <p id="style-source-notice" class="style-source-notice" role="status" hidden></p>
  <div id="attach-modal" hidden><div class="attach-modal"><p id="attach-formats-note"></p><p class="attach-capability-note"></p><div id="attach-modal-list"></div></div></div>
  <div id="attach-close-confirm" hidden role="dialog" aria-modal="true" aria-labelledby="attach-close-text">
    <p id="attach-close-text"></p>
    <button id="btn-attach-cancel"></button>
    <button id="btn-attach-confirm"></button>
  </div>
  <button id="btn-model"></button>
</main>`;

/** The editor composer controls editor-attachments.js mounts on. */
export const EDITOR_MARKUP = `
<div id="agent-attachments" hidden></div>
<p id="style-source-notice" class="style-source-notice" role="status" hidden></p>
<textarea id="work-brief"></textarea>
<button id="composer-plus" type="button"></button>
<input id="agent-attachment-file" type="file" multiple hidden />`;

export const PARSED_PNG = {
  id: "att-png",
  name: "sample.png",
  size: 1200,
  kind: "image",
  status: "parsed",
  parser: "image-sharp-v1",
  summary: { zh: "PNG 图片 · 1200×800 · 主色 #F4F1EA" },
  warnings: [],
  needsVision: true,
};
export const PARSED_XLSX = {
  id: "att-xlsx",
  name: "sample.xlsx",
  size: 2048,
  kind: "table",
  status: "parsed",
  parser: "xlsx-ooxml-v1",
  summary: { zh: "XLSX 表格 · 2 个工作表 · 共 120 行" },
  warnings: [],
  needsVision: false,
};
export const PARSED_PDF = {
  id: "att-pdf",
  name: "text.pdf",
  size: 4096,
  kind: "document",
  status: "parsed",
  parser: "pdf-unpdf-v3",
  summary: { zh: "PDF · 5 页 · 约 255 字" },
  warnings: [],
  needsVision: false,
};
export const PARSED_DOCX = {
  id: "att-docx",
  name: "report.docx",
  size: 3072,
  kind: "document",
  status: "parsed",
  parser: "docx-ooxml-v1",
  summary: { zh: "Word 文档 · 2 个标题" },
  warnings: [],
  needsVision: false,
};
export const UNSUPPORTED_PPT = {
  id: "att-ppt",
  name: "legacy.ppt",
  size: 512,
  kind: null,
  status: "unsupported",
  parser: null,
  summary: null,
  warnings: [],
  needsVision: false,
  errorCode: "legacy-office-format",
  message: "这是旧版 PPT（.ppt）格式，请另存为 .pptx 后再上传",
};

/** Pictures extracted from a DOCX, one per even paragraph.
 * @param {number} count @param {string} [prefix] */
export function embedded(count, prefix = "emb") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `报告-image${index + 1}.png`,
    size: 900 + index,
    kind: "image",
    status: "parsed",
    parser: "image-sharp-v1",
    summary: { zh: `来自文档第 ${index * 2 + 2} 段 · PNG 图片 · 64×64` },
    warnings: [],
    needsVision: true,
    origin: "docx",
    note: `来自文档第 ${index * 2 + 2} 段`,
    position: { paragraph: index * 2 + 2 },
    width: 64,
    height: 64,
  }));
}

/** A parsed Word document with `count` embedded pictures.
 * @param {number} count @param {Record<string, unknown>} [overrides] */
export function documentPayload(count, overrides = {}) {
  return {
    id: "doc-1",
    name: "报告.docx",
    size: 20_480,
    kind: "document",
    status: "parsed",
    parser: "docx-ooxml-v1",
    summary: { zh: "Word 文档 · 2 个标题" },
    warnings: [],
    needsVision: false,
    ...(count ? { embeddedImages: embedded(count) } : {}),
    ...overrides,
  };
}

/** A standalone photo upload. @param {number} index */
export const imagePayload = (index) => ({
  id: `own-${index}`,
  name: `own-${index}.png`,
  size: 100,
  kind: "image",
  status: "parsed",
  parser: "image-sharp-v1",
  summary: { zh: "PNG 图片 · 10×10" },
  warnings: [],
  needsVision: true,
});

/** An image ZIP pack of eight photos. */
export function imagePackPayload() {
  const imageMaterials = Array.from({ length: 8 }, (_, index) => ({
    id: `pack-image-${index + 1}`,
    name: `照片${index + 1}.jpg`,
    size: 300 + index,
    kind: "image",
    status: "parsed",
    parser: "image-sharp-v1",
    summary: { zh: "JPG 图片 · 320×240" },
    warnings: [],
    needsVision: true,
  }));
  return {
    id: "pack-parent",
    name: "photos.zip",
    size: 4096,
    kind: "image",
    status: "parsed",
    parser: "image-pack-v1",
    summary: { zh: "图片包 · 8 张图片" },
    warnings: [{ code: "non-image-entry", message: "未加入非图片条目：说明.txt、__MACOSX/" }],
    needsVision: true,
    imageMaterials,
  };
}

// Only when this file itself is the test entry, not when another test imports it.
const isEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] || "").href;

function harnessSelfTest() {
  test("the attachment DOM harness installs and restores browser globals", async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "document");
    const env = installDom('<div id="probe"></div>');
    assert.equal(required("probe").id, "probe");
    new XMLHttpRequest().open("POST", "/x");
    assert.equal(xhr(0).url, "/x");
    assert.equal((await fetch("/api/health")).status, 404);
    assert.deepEqual(fetchedUrls(env.fetchMock), ["/api/health"]);
    await env.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "document"), before);
  });
}
if (isEntry) harnessSelfTest();
