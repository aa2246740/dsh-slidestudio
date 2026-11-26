import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { childProcessEnv } from "./child-env.mjs";
import { probePdfRenderChild } from "./pdf-render.mjs";
import { runPdfImagesChild } from "./pdf-images-run.mjs";

/** Stand-in child that answers both the render and the extraction protocol. */
const STUB = fileURLToPath(new URL("./test-fixtures/pdf-images-stub-child.mjs", import.meta.url));

/**
 * Sets parent environment variables for the duration of `body`, then restores them.
 * @template T
 * @param {Record<string, string>} values
 * @param {() => Promise<T>} body
 */
async function withParentEnv(values, body) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Names a child received, without what fork itself adds (Node's IPC bootstrap
 * variables) or what macOS adds (__CF_USER_TEXT_ENCODING).
 * @param {string} file
 */
function receivedNames(file) {
  return /** @type {string[]} */ (JSON.parse(fs.readFileSync(file, "utf8")))
    .filter((name) => !name.startsWith("NODE_CHANNEL_") && !name.startsWith("__CF_"))
    .sort();
}

/** @param {string} root */
const secretEnv = (root) => ({
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  OSS_CHILD_PROBE_SECRET: "credential-that-must-not-leak",
});

describe("PDF child process environment", () => {
  test("childProcessEnv passes PATH and the temp variables and nothing else", () => {
    assert.deepEqual(
      childProcessEnv({
        PATH: "/bin",
        TMPDIR: "/tmp/run",
        TMP: "/tmp/run",
        TEMP: "/tmp/run",
        HOME: "/Users/operator",
        DEEPSEEK_API_KEY: "sk-test-value",
        OSS_SECRET: "value",
      }),
      { PATH: "/bin", TMPDIR: "/tmp/run", TMP: "/tmp/run", TEMP: "/tmp/run" },
    );
  });

  test("childProcessEnv omits unset or empty temp variables and defaults PATH", () => {
    assert.deepEqual(childProcessEnv({ TMPDIR: "", TMP: undefined }), { PATH: "/usr/bin:/bin" });
  });

  test("the page render child is forked with PATH and the temp variables only", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "child-env-render-"));
    try {
      const available = await withParentEnv(secretEnv(tempRoot), () => probePdfRenderChild({ childPath: STUB }));
      assert.equal(available, true);
      // The stub writes into its own os.tmpdir(), so the file exists only if TMPDIR crossed.
      const names = receivedNames(path.join(tempRoot, "pdf-child-env.json"));
      assert.deepEqual(names, ["PATH", "TEMP", "TMP", "TMPDIR"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("the real render probe resolves a boolean, false without the optional canvas", async () => {
    const available = await probePdfRenderChild();
    assert.equal(typeof available, "boolean");
  });

  test("the PDF image extraction child is forked with PATH and the temp variables only", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "child-env-images-"));
    const reportEnvTo = path.join(tempRoot, "env.json");
    try {
      const result = await withParentEnv(secretEnv(tempRoot), () =>
        runPdfImagesChild({
          bytes: Buffer.from(JSON.stringify({ mode: "ok", pages: 1, reportEnvTo })),
          overrides: { childPath: STUB },
        }),
      );
      assert.equal(result.countComplete, true);
      assert.deepEqual(receivedNames(reportEnvTo), ["PATH", "TEMP", "TMP", "TMPDIR"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
