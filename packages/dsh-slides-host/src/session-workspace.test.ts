import { test } from "node:test";
import assert from "node:assert/strict";
import { organizeSlidesSessions } from "./session-workspace.js";

test("organizes only owned Slides sessions at their real cwd, once per workspace", async () => {
  const created: string[] = [], attached: string[] = [];
  const registry = { async create(path: string, title?: string) {
    created.push(path); assert.equal(title, "演示文稿 · SlideStudio");
    return { async attachSession(id: string) { attached.push(`${path}:${id}`); } };
  } };
  const result = await organizeSlidesSessions(registry, [
    { id: "a", agentPreset: "slides", cwd: "/old" },
    { id: "b", agentPreset: "slides", cwd: "/old" },
    { id: "c", agentPreset: "slides", cwd: "/new" },
    { id: "user", agentPreset: "standard", cwd: "/old" },
    { id: "stale", agentPreset: "standard", cwd: "/old" },
    { id: "unbound", agentPreset: "slides", cwd: "/elsewhere" },
    { id: "missing", agentPreset: "slides" },
  ], new Set(["a", "b", "c", "stale", "missing"]));
  assert.deepEqual(created, ["/old", "/new"]);
  assert.deepEqual(attached, ["/old:a", "/old:b", "/new:c"]);
  assert.deepEqual(result, { attached: 3, failures: [] });
});

test("a removed legacy directory cannot prevent other sessions being organized", async () => {
  const attached: string[] = [];
  const result = await organizeSlidesSessions({ async create(path) {
    if (path === "/gone") throw new Error("directory missing");
    return { async attachSession(id) { attached.push(id); } };
  } }, [
    { id: "a", cwd: "/gone", agentPreset: "slides" },
    { id: "b", cwd: "/present", agentPreset: "slides" },
  ], new Set(["a", "b"]));
  assert.deepEqual(attached, ["b"]);
  assert.deepEqual(result, { attached: 1, failures: ["a: directory missing"] });
});
