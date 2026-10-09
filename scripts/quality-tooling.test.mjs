import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import * as prettier from "prettier";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, "eslint.config.mjs") });
const appSources = [
  "apps/native-web/public/app.js",
  "apps/server/src/index.mjs",
  "apps/web/src/App.tsx",
  "dsh-slidestudio/src/client/index.tsx",
];

test("every app has blocking correctness rules, including TypeScript and JSX parsing", async () => {
  for (const filePath of appSources) {
    const config = await eslint.calculateConfigForFile(path.join(ROOT, filePath));
    assert.ok(config, filePath);
    assert.equal(config.rules["no-dupe-keys"][0], 2, filePath);
    const [result] = await eslint.lintText("export const data = { value: 1, value: 2 };\n", {
      filePath: path.join(ROOT, filePath),
    });
    assert.ok(
      result.messages.some((message) => message.ruleId === "no-dupe-keys" && message.severity === 2),
      filePath,
    );
  }
});

test("browser globals and classic-script helpers are explicit, unknown names still fail", async () => {
  const [result] = await eslint.lintText("window.console.log(isDarkCss('white'), missingHelper());\n", {
    filePath: path.join(ROOT, "apps/native-web/public/app.js"),
  });
  assert.deepEqual(
    result.messages.filter((message) => message.ruleId === "no-undef").map((message) => message.message),
    ["'missingHelper' is not defined."],
  );
});

test("unsafe finally returns and conditional React Hooks block validation", async () => {
  const [flow] = await eslint.lintText("export function run() { try { return 1; } finally { return 2; } }\n", {
    filePath: path.join(ROOT, "apps/server/src/index.mjs"),
  });
  assert.ok(flow.messages.some((message) => message.ruleId === "no-unsafe-finally" && message.severity === 2));
  const [react] = await eslint.lintText(
    'import { useState } from "react";\nexport function Widget({ show }: { show: boolean }) { if (show) useState(0); return null; }\n',
    { filePath: path.join(ROOT, "apps/web/src/Widget.tsx") },
  );
  assert.ok(
    react.messages.some((message) => message.ruleId === "react-hooks/rules-of-hooks" && message.severity === 2),
  );
});

test("cleanup debt stays visible rather than being disabled", async () => {
  const [result] = await eslint.lintText("const unusedValue = 1;\n", {
    filePath: path.join(ROOT, "apps/server/src/index.mjs"),
  });
  assert.ok(result.messages.some((message) => message.ruleId === "no-unused-vars" && message.severity === 1));
});

// Existing app.js is a listed legacy exception in .prettierignore, so use a formatted file for native-web.
const formattedSources = ["apps/native-web/src/logger.mjs", ...appSources.slice(1)];

test("Prettier covers every app and converges to the configured style", async () => {
  for (const file of formattedSources) {
    const filePath = path.join(ROOT, file);
    const info = await prettier.getFileInfo(filePath, { ignorePath: path.join(ROOT, ".prettierignore") });
    assert.equal(info.ignored, false, file);
    assert.ok(info.inferredParser, file);
    const options = { ...(await prettier.resolveConfig(filePath)), parser: info.inferredParser };
    const source = "const data={value:1}\n";
    assert.equal(await prettier.check(source, options), false, file);
    const formatted = await prettier.format(source, options);
    assert.equal(await prettier.check(formatted, options), true, file);
  }
});

test("formatting and linting exclude snapshots, generated output and release workflows", async () => {
  for (const file of [
    "vendor/dsh-llm-pi-ai/lib/index.js",
    "_reference/prototype/src/lib/auth/client.ts",
    "packages/pptd-v2/dist/index.js",
    "dsh-slidestudio/lib/client.js",
    "output/example.js",
  ]) {
    const filePath = path.join(ROOT, file);
    assert.equal(await eslint.isPathIgnored(filePath), true, file);
    assert.equal(
      (await prettier.getFileInfo(filePath, { ignorePath: path.join(ROOT, ".prettierignore") })).ignored,
      true,
      file,
    );
  }
  assert.equal(
    (
      await prettier.getFileInfo(path.join(ROOT, ".github/workflows/ci.yml"), {
        ignorePath: path.join(ROOT, ".prettierignore"),
      })
    ).ignored,
    true,
  );
});

test("documented root commands and bootstrap stages refer to real scripts", () => {
  const { scripts } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const name of ["AGENTS.md", "README.md"]) {
    const text = readFileSync(path.join(ROOT, name), "utf8");
    for (const [, command] of text.matchAll(/`?npm run ([\w:-]+)/g)) {
      assert.ok(scripts[command], `${name}: missing script ${command}`);
    }
  }
  assert.equal(scripts["setup:dev"], "npm ci && npm run build:native && npm run setup:browser && npm start");
});
