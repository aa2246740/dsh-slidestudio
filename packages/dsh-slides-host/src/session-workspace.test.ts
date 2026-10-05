import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureSessionUnarchived,
  hideSlidesSessions,
  slidesSessionMeta,
  SLIDES_WORKSPACE_TITLE,
  type SlidesWorkspaceRegistry,
} from "./session-workspace.js";

function fakeRegistry(overrides: Partial<SlidesWorkspaceRegistry> = {}) {
  const calls = { archived: [] as string[], deleted: [] as string[] };
  const registry: SlidesWorkspaceRegistry = {
    list: () => [],
    delete: async (id) => {
      calls.deleted.push(id);
      return true;
    },
    archivedSessionIds: [],
    archiveSession: async (id) => {
      calls.archived.push(id);
    },
    unarchiveSession: async () => {},
    ...overrides,
  };
  return { registry, calls };
}

test("archives slides sessions; skips subagents, children, archived, non-slides and foreign-cwd", async () => {
  const { registry, calls } = fakeRegistry({ archivedSessionIds: ["old"] });
  const result = await hideSlidesSessions(registry, [
    { id: "owned", agentPreset: "slides", cwd: "/anywhere" },
    { id: "pool", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
    { id: "pool-sep", agentPreset: "slides", cwd: "C:\\x\\output\\dsh-slices\\" },
    { id: "sub", agentPreset: "slides", cwd: "/x/output/dsh-slices", origin: "subagent" },
    { id: "child", agentPreset: "slides", cwd: "/x/output/dsh-slices", parentSession: "p" },
    { id: "old", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
    { id: "other", agentPreset: "standard", cwd: "/x/output/dsh-slices" },
    { id: "user", agentPreset: "slides", cwd: "/home/user/project" },
  ], new Set(["owned"]));
  assert.deepEqual(calls.archived.sort(), ["owned", "pool", "pool-sep"].sort());
  assert.deepEqual(result, { archived: 3, removedWorkspaces: 0, failures: [] });
});

test("one archive failure is recorded and the sweep continues", async () => {
  const { registry } = fakeRegistry({
    archiveSession: async (id) => {
      if (id === "busy") throw new Error("session is active");
    },
  });
  const result = await hideSlidesSessions(registry, [
    { id: "busy", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
    { id: "fine", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
  ], new Set());
  assert.equal(result.archived, 1);
  assert.deepEqual(result.failures, ["busy: session is active"]);
});

test("deletes SlideStudio-titled workspaces holding only slides sessions", async () => {
  const { registry, calls } = fakeRegistry({
    list: () => [
      { id: "w-all", path: "/x/output/dsh-slices", title: SLIDES_WORKSPACE_TITLE, sessionIds: ["a", "b"] },
      { id: "w-empty", path: "/x/output/dsh-slices", title: SLIDES_WORKSPACE_TITLE, sessionIds: [] },
      { id: "w-mixed", path: "/x/output/dsh-slices", title: SLIDES_WORKSPACE_TITLE, sessionIds: ["a", "user"] },
      { id: "w-other", path: "/x", title: "Other", sessionIds: ["a"] },
    ],
  });
  const result = await hideSlidesSessions(registry, [
    { id: "a", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
    { id: "b", agentPreset: "slides", cwd: "/x/output/dsh-slices" },
  ], new Set());
  assert.deepEqual(calls.deleted, ["w-all", "w-empty"]);
  assert.equal(result.removedWorkspaces, 2);
  assert.deepEqual(result.failures, []);
});

test("slidesSessionMeta marks generation sessions as sidebar-hidden subagents", () => {
  assert.deepEqual(slidesSessionMeta("/data/output/dsh-slices"), {
    cwd: "/data/output/dsh-slices",
    agentPreset: "slides",
    origin: "subagent",
  });
});

test("ensureSessionUnarchived unarchives an archived session before resume", async () => {
  const order: string[] = [];
  const { registry } = fakeRegistry({
    archivedSessionIds: ["s1"],
    unarchiveSession: async (id) => {
      order.push(`unarchive:${id}`);
    },
  });
  await ensureSessionUnarchived(registry, "s1");
  order.push("resume");
  assert.deepEqual(order, ["unarchive:s1", "resume"]);
});

test("ensureSessionUnarchived skips live sessions and missing registries", async () => {
  const calls: string[] = [];
  const { registry } = fakeRegistry({
    archivedSessionIds: ["s1"],
    unarchiveSession: async (id) => {
      calls.push(id);
    },
  });
  await ensureSessionUnarchived(registry, "s2");
  await ensureSessionUnarchived(undefined, "s1");
  assert.deepEqual(calls, []);
});

test("workspace delete failures are recorded", async () => {
  const { registry } = fakeRegistry({
    list: () => [
      { id: "w1", path: "/x", title: SLIDES_WORKSPACE_TITLE, sessionIds: [] },
    ],
    delete: async () => {
      throw new Error("locked");
    },
  });
  const result = await hideSlidesSessions(registry, [], new Set());
  assert.equal(result.removedWorkspaces, 0);
  assert.deepEqual(result.failures, ["w1: locked"]);
});
