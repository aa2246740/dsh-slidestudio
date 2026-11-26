import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { acquireProjectLease, readProjectLease } from "@open-slidestudio/slides-tools";
import { guardEditorWrite } from "./editor-lease.mjs";
import { editorLeaseBeaconAllowed, handleEditorLeaseRoutes } from "./editor-lease-routes.mjs";
import { holdLeaseLock, removeLeaseFixtures, startLeaseServer, tempLeaseProject } from "./editor-lease-fixtures.mjs";
import {
  EDITOR_LEASE_MESSAGES,
  createEditorLeaseClient,
  editorLeaseRefusalMessage,
  isEditorLeaseRefusal,
} from "../public/editor-lease.js";
import { EDITOR_LEASE_I18N } from "../public/editor-lease-i18n.js";

/** @type {{ base: string, close: () => Promise<unknown> }} */
let http;

before(async () => {
  http = await startLeaseServer({ handle: handleEditorLeaseRoutes, beaconAllowed: editorLeaseBeaconAllowed });
});
after(async () => {
  await http.close();
  removeLeaseFixtures();
});

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function call(path, init) {
  const res = await fetch(`${http.base}${path}`, init);
  return { status: res.status, body: await res.json() };
}

/** @param {unknown} body */
function postJson(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("editor lease routes", () => {
  it("releases this tab's lease from a sendBeacon-style text/plain JSON body", async () => {
    const root = tempLeaseProject("lease-route-beacon");
    assert.equal(guardEditorWrite(root, { tabId: "tab-beacon" }).ok, true);
    const beacon = await call("/api/lease/release", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ project: root, tabId: "tab-beacon" }),
    });
    assert.deepEqual(beacon, { status: 200, body: { ok: true, released: true } });
    assert.equal(readProjectLease(root).holder, undefined);

    const again = await call("/api/lease/release", postJson({ project: root, tabId: "tab-beacon" }));
    assert.deepEqual(again, { status: 200, body: { ok: true, released: false } }, "not held: released false");
  });

  it("only exempts the release route from the JSON content-type rule", async () => {
    const root = tempLeaseProject("lease-route-type");
    const acquire = await call("/api/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ project: root, tabId: "t" }),
    });
    assert.equal(acquire.status, 415);
    const url = new URL("http://127.0.0.1/api/lease/release");
    assert.equal(editorLeaseBeaconAllowed({ method: "GET", headers: { "content-type": "text/plain" } }, url), false);
    assert.equal(editorLeaseBeaconAllowed({ method: "POST", headers: { "content-type": "text/html" } }, url), false);
  });

  it("never releases a lease another owner holds", async () => {
    const root = tempLeaseProject("lease-route-foreign");
    acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:s1", label: "Hub run" });
    const released = await call("/api/lease/release", postJson({ project: root, tabId: "tab-1" }));
    assert.deepEqual(released.body, { ok: true, released: false });
    assert.equal(readProjectLease(root).holder?.ownerId, "hub-run:s1");
  });

  it("acquires, renews and refuses through POST /api/lease/acquire", async () => {
    const root = tempLeaseProject("lease-route-acquire");
    const first = await call(`/api/lease/acquire?tab=tab-1`, postJson({ project: root }));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, "acquired");
    assert.equal(first.body.lease.kind, "editor-human");
    const renewed = await call(`/api/lease/acquire?tab=tab-1`, postJson({ project: root }));
    assert.equal(renewed.body.outcome, "renewed");

    const hubRoot = tempLeaseProject("lease-route-hub");
    acquireProjectLease(hubRoot, { kind: "hub-run", ownerId: "hub-run:s2", label: "Hub run" });
    const refused = await call(`/api/lease/acquire`, postJson({ project: hubRoot, tabId: "tab-1" }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "WRITER_LEASE_CONFLICT");
    assert.equal(refused.body.holder.kind, "hub-run");
    assert.equal(readProjectLease(hubRoot).holder?.ownerId, "hub-run:s2");
  });

  it("maps a stuck lock to 503, a missing project to 404 and bad JSON to 400", async () => {
    const root = tempLeaseProject("lease-route-errors");
    guardEditorWrite(root, { tabId: "t" });
    const unlock = holdLeaseLock(root);
    try {
      const busy = await call("/api/lease/release", postJson({ project: root, tabId: "t" }));
      assert.equal(busy.status, 503);
      assert.equal(busy.body.code, "WRITER_LEASE_BUSY");
    } finally {
      unlock();
    }
    const missing = await call("/api/lease/release", postJson({ project: `${root}-gone`, tabId: "t" }));
    assert.equal(missing.status, 404);
    const bad = await call("/api/lease/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(bad.status, 400);
  });

  it("GET /api/lease shows the holder without secrets", async () => {
    const root = tempLeaseProject("lease-route-view");
    acquireProjectLease(root, { kind: "mcp", ownerId: "mcp:secret-session", label: "agent" });
    guardEditorWrite(root, { tabId: "tab-v" });
    const view = await call(`/api/lease?project=${encodeURIComponent(root)}&tab=tab-v`);
    assert.equal(view.status, 200);
    assert.equal(view.body.mine, true);
    assert.equal(view.body.holder.kind, "editor-human");
    assert.deepEqual(
      view.body.waiting.map((/** @type {{ kind: string }} */ row) => row.kind),
      ["mcp"],
    );
    assert.doesNotMatch(JSON.stringify(view.body), /pid|hostname|token|secret-session/);
    assert.equal((await call("/api/nothing")).status, 404, "unrelated routes fall through");
  });
});

describe("editor lease browser client", () => {
  /** A sendBeacon double that really posts the Blob the way a browser does. */
  function beaconThatPosts() {
    /** @type {Promise<unknown>[]} */
    const sent = [];
    /** @type {string[]} */
    const types = [];
    const sendBeacon = (/** @type {string} */ url, /** @type {Blob} */ data) => {
      types.push(data.type);
      sent.push(
        data
          .text()
          .then((body) =>
            fetch(`${http.base}${url}`, { method: "POST", headers: { "Content-Type": data.type }, body }),
          ),
      );
      return true;
    };
    return { sendBeacon, sent, types };
  }

  it("releases on pagehide via sendBeacon and deduplicates beforeunload", async () => {
    const root = tempLeaseProject("lease-client-beacon");
    guardEditorWrite(root, { tabId: "tab-c" });
    const target = new EventTarget();
    const beacon = beaconThatPosts();
    const client = createEditorLeaseClient({
      project: () => root,
      tabId: () => "tab-c",
      sendBeacon: beacon.sendBeacon,
      windowTarget: target,
      fetch: () => Promise.reject(new Error("fetch must not run when the beacon queued")),
    });
    client.attach();
    target.dispatchEvent(new Event("pagehide"));
    target.dispatchEvent(new Event("beforeunload"));
    await Promise.all(beacon.sent);
    assert.equal(beacon.sent.length, 1, "pagehide + beforeunload release once");
    assert.match(beacon.types[0] ?? "", /^text\/plain/);
    assert.equal(readProjectLease(root).holder, undefined);
    client.detach();
    target.dispatchEvent(new Event("pagehide"));
    assert.equal(beacon.sent.length, 1, "detached listeners stay quiet");
  });

  it("falls back to fetch keepalive when sendBeacon is missing or refuses", async () => {
    const root = tempLeaseProject("lease-client-fetch");
    guardEditorWrite(root, { tabId: "tab-f" });
    /** @type {Promise<Response>[]} */
    const posted = [];
    /** @type {RequestInit[]} */
    const inits = [];
    const client = createEditorLeaseClient({
      project: () => root,
      tabId: "tab-f",
      sendBeacon: () => false,
      windowTarget: null,
      fetch: (input, init) => {
        inits.push(init ?? {});
        const res = fetch(`${http.base}${String(input)}`, init);
        posted.push(res);
        return res;
      },
    });
    assert.equal(client.releaseOnUnload(), true);
    await Promise.all(posted);
    assert.equal(inits[0]?.keepalive, true);
    assert.equal(readProjectLease(root).holder, undefined);
  });

  it("release() ends the session explicitly and reports whether a lease was held", async () => {
    const root = tempLeaseProject("lease-client-explicit");
    guardEditorWrite(root, { tabId: "tab-e" });
    const relay = (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) =>
      fetch(`${http.base}${String(input)}`, init);
    const client = createEditorLeaseClient({ project: () => root, tabId: "tab-e", fetch: relay, sendBeacon: null });
    assert.deepEqual(await client.release(), { released: true });
    assert.deepEqual(await client.release(), { released: false });
    const empty = createEditorLeaseClient({ project: () => "", tabId: "tab-e", fetch: relay, sendBeacon: null });
    assert.equal(await empty.release(), null, "no project, nothing to release");
    assert.equal(empty.releaseOnUnload(), false);

    const previous = tempLeaseProject("lease-client-previous");
    guardEditorWrite(previous, { tabId: "tab-e" });
    assert.deepEqual(await empty.release({ project: previous }), { released: true }, "release before switching");
    assert.equal(readProjectLease(previous).holder, undefined);
  });

  it("releases when the document turns hidden only if a document target is supplied", () => {
    /** @type {string[]} */
    const payloads = [];
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const client = createEditorLeaseClient({
      project: () => "/deck",
      tabId: "tab-h",
      windowTarget: null,
      documentTarget: doc,
      sendBeacon: (_url, data) => {
        payloads.push(data.type);
        return true;
      },
    });
    client.attach();
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(payloads.length, 0);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(payloads.length, 1);
  });

  it("decodes lease refusals into translated copy", () => {
    assert.equal(isEditorLeaseRefusal(409, { code: "WRITER_LEASE_CONFLICT" }), true);
    assert.equal(isEditorLeaseRefusal(503, { code: "WRITER_LEASE_BUSY" }), true);
    assert.equal(isEditorLeaseRefusal(409, { code: "BASE_REVISION_STALE" }), false);
    assert.equal(isEditorLeaseRefusal(200, { code: "WRITER_LEASE_CONFLICT" }), false);
    assert.equal(
      editorLeaseRefusalMessage({ code: "WRITER_LEASE_CONFLICT", holder: { kind: "hub-run" } }),
      EDITOR_LEASE_MESSAGES["hub-run"],
    );
    assert.equal(editorLeaseRefusalMessage({ code: "WRITER_LEASE_BUSY" }), EDITOR_LEASE_MESSAGES.busy);
    assert.equal(
      editorLeaseRefusalMessage({ code: "WRITER_LEASE_CONFLICT", holder: null }),
      EDITOR_LEASE_MESSAGES.other,
    );
    for (const text of Object.values(EDITOR_LEASE_MESSAGES)) {
      assert.equal(typeof (/** @type {Record<string, string>} */ (EDITOR_LEASE_I18N)[text]), "string", text);
    }
  });

  it("uses the same Chinese copy the server sends", () => {
    const root = tempLeaseProject("lease-client-copy");
    acquireProjectLease(root, { kind: "hub-run", ownerId: "hub-run:s9" });
    const refused = guardEditorWrite(root, { tabId: "t" });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(editorLeaseRefusalMessage(refused.body), refused.body.error);
  });
});
