/** Offline checks for the 0.2.2-rc.5 host contract. No network and no model calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { externalClientBundle, INLINE_SAFE, PLATFORM_MODULES } from "../tools/client-build.mjs";

const manifestPath = fileURLToPath(new URL("../../docs/architecture/dsh-surface-manifest.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  if (!match) throw new Error(`bad version ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : null,
  };
}

function comparePre(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left[index]) - Number(right[index]);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (leftNumeric) return -1;
    else if (rightNumeric) return 1;
    else if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

function caretCeiling(version) {
  const parsed = parseVersion(version);
  if (parsed.major > 0) return `${parsed.major + 1}.0.0`;
  if (parsed.minor > 0) return `0.${parsed.minor + 1}.0`;
  return `0.0.${parsed.patch + 1}`;
}

function satisfies(version, range) {
  return range.split("||").some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => {
        const caret = /^\^([0-9A-Za-z.+-]+)$/.exec(token);
        if (caret) return satisfies(version, `>=${caret[1]} <${caretCeiling(caret[1])}`);
        const match = /^(>=|<=|>|<|=)([0-9A-Za-z.+-]+)$/.exec(token);
        if (!match) throw new Error(`unsupported range token ${token} in ${range}`);
        const diff = compareVersions(version, match[2]);
        if (match[1] === ">=") return diff >= 0;
        if (match[1] === "<=") return diff <= 0;
        if (match[1] === ">") return diff > 0;
        if (match[1] === "<") return diff < 0;
        return diff === 0;
      }),
  );
}

test("engines.dsh covers rc.2, rc.5 and 0.2.2, and rejects 0.3.0", () => {
  const range = packageJson.engines?.dsh;
  assert.equal(typeof range, "string");
  for (const version of ["0.2.0-rc.2", "0.2.2-rc.5", "0.2.2"]) {
    assert.equal(satisfies(version, range), true, version);
  }
  assert.equal(satisfies("0.3.0", range), false);
  assert.equal(satisfies("0.1.5", range), false);
});

test("engines.node accepts 22.19 and the 24.9+ line rc.5 asks for", () => {
  const range = packageJson.engines?.node;
  assert.equal(range, "^22.19.0 || >=24.9.0");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.compatibleRange.node, range);
  for (const version of ["22.19.0", "22.20.0", "24.9.0", "24.10.0", "24.11.0", "26.0.0"]) {
    assert.equal(satisfies(version, range), true, version);
  }
  for (const version of ["22.18.0", "23.0.0", "24.8.9"]) {
    assert.equal(satisfies(version, range), false, version);
  }
});

test("client bundle purity resolveId allows safe specifiers and rejects cross-plugin imports", () => {
  const configs = externalClientBundle("dsh-slidestudio", [], { clientEntry: "src/client/index.tsx" });
  const client = configs.find((config) =>
    config.plugins?.some((plugin) => plugin.name === "dshx-client-bundle-purity"),
  );
  assert.ok(client, "client config was not produced");
  const plugin = client.plugins.find((item) => item.name === "dshx-client-bundle-purity");
  const resolveId = plugin.resolveId.bind(plugin);
  for (const source of [
    "react",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/cosmokit",
    "@deepseek-ai/schemastery/src",
    "@deepseek-ai/cordis-plugin-timer",
    "@deepseek-ai/dsh-agent/remote",
  ]) {
    assert.equal(resolveId(source), null, source);
  }
  assert.throws(() => resolveId("@deepseek-ai/dsh-agent"), /client bundle purity: "@deepseek-ai\/dsh-agent"/);
});

test("client bundle recipe keeps the rc.5 inline-safe list", () => {
  assert.equal(
    INLINE_SAFE.source,
    "^(?:@deepseek-ai\\/dsh-(?:file-reference|fs-patch|session|llm|tools|brand|official-bundles|deque|output-retention|typert-protocol|util-crypto|util-time|util-values|util-workspace-path)(?:\\/|$)|@deepseek-ai\\/dsh-util-file-drag$|@deepseek-ai\\/dsh-token-meter\\/client$|@deepseek-ai\\/dsh-commands\\/builtin$|@deepseek-ai\\/dsh-native-command\\/types$|@deepseek-ai\\/dsh-host-open-in-app\\/shared$|@deepseek-ai\\/dsh-plugin-manager\\/registry$|@deepseek-ai\\/dsh-agent-preset-registry\\/display$|@deepseek-ai\\/dsh-api-workspace-controller\\/default-workspace$|@deepseek-ai\\/dsh-spill-policy\\/notice$)",
  );
  for (const name of [
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-dockkit",
  ]) {
    assert.equal(PLATFORM_MODULES.includes(name), true, name);
  }
});

function iframeSrc(tree) {
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.type === "iframe") return tree.props?.src;
  return iframeSrc(tree.props?.children);
}

function mountClient(active) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const registrations = [];
  const jsx = (type, props) => {
    const next = props ?? {};
    if (typeof type === "function") return type(next);
    return { type, props: next };
  };
  let client;
  const sandbox = {
    location: { origin: "dsh-app://app", href: "dsh-app://app/" },
    document: {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    URL,
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, "dsh-slidestudio");
        client = factory((name) => {
          if (name === "react") {
            return {
              useSyncExternalStore(_subscribe, getSnapshot) {
                return getSnapshot();
              },
              useState(value) {
                return [value, () => undefined];
              },
            };
          }
          if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
          return {};
        });
      },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "client.js" });
  client.apply({
    get(name) {
      if (name !== "locale" || active === false) return undefined;
      return {
        getLocale: () => ({ active: active === null ? undefined : active }),
        subscribe: () => () => undefined,
      };
    },
    effect(fn) {
      const stop = fn();
      return stop;
    },
    inject() {},
    slots: {
      inject(_name, fn) {
        fn();
        return () => undefined;
      },
      register(entry, component) {
        registrations.push({ entry, component });
        return () => undefined;
      },
    },
  });
  const panel = registrations.find((row) => row.entry.name === "sidebar.panellist");
  const main = registrations.find((row) => row.entry.name === "main");
  assert.ok(panel, "sidebar.panellist was not registered");
  assert.ok(main, "main Slides page was not registered");
  return {
    label: panel.entry.label(),
    src: iframeSrc(main.component({})),
  };
}

for (const [active, chinese] of [
  [false, true],
  [null, true],
  ["zh", true],
  ["zh-CN", true],
  ["en", false],
  ["ja", false],
  ["fr", false],
]) {
  test(`locale ${active === false ? "missing" : String(active)} falls back to ${chinese ? "zh" : "en"}`, () => {
    const view = mountClient(active);
    assert.equal(view.label, chinese ? "演示文稿" : "Slides");
    assert.match(view.src, chinese ? /\/app\/hub\.html\?lang=zh$/ : /\/app\/hub\.html\?lang=en$/);
  });
}

test("a non-zh settings menu matches aria-keyshortcuts and times out without throwing", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  function run(matchAria, ticks) {
    const state = { menu: false, clicks: 0 };
    const intervals = new Map();
    const messages = [];
    let message;
    let id = 0;
    let client;
    const item = {
      disabled: false,
      click() {
        state.clicks += 1;
      },
      getAttribute: () => (matchAria ? "Control+Shift+Comma" : null),
      cloneNode: () => ({ textContent: "設定", querySelectorAll: () => [] }),
    };
    const launcher = {
      disabled: false,
      click() {
        state.menu = true;
      },
      getAttribute: () => String(state.menu),
    };
    const origin = "dsh-app://app";
    const sandbox = {
      location: { origin, href: `${origin}/` },
      URL,
      document: {
        querySelector(selector) {
          if (selector === '[data-shortcut-modal="settings"]') return null;
          if (selector.includes('[role="dialog"]')) return null;
          if (selector === '[data-slot="sidebar.settings"]') return {};
          if (selector.includes("settings.trigger")) return null;
          if (selector.includes("settings.launcher")) return launcher;
          return null;
        },
        querySelectorAll: () => (state.menu ? [item] : []),
      },
      setInterval(fn) {
        intervals.set(++id, fn);
        return id;
      },
      clearInterval(key) {
        intervals.delete(key);
      },
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
      addEventListener(type, fn) {
        if (type === "message") message = fn;
      },
      removeEventListener() {},
      __ModuleLoader__: {
        load({ factory }) {
          client = factory(() => ({}));
        },
      },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: "client.js" });
    client.apply({
      get(name) {
        if (name === "locale") return { getLocale: () => ({ active: "ja" }), subscribe: () => () => undefined };
        if (name === "shortcuts")
          return { catalog: { getSnapshot: () => [{ id: "settings.open", aria: "Control+Shift+Comma" }] } };
        if (name === "layout") return { selectPanel() {}, beginNavigation: () => ({ aborted: false }) };
        return undefined;
      },
      effect(fn) {
        fn();
      },
      inject() {},
      slots: {
        inject(_name, fn) {
          fn();
          return () => undefined;
        },
        register() {
          return () => undefined;
        },
      },
    });
    message({
      origin,
      data: { type: "oss:open-dsh-settings" },
      source: {
        postMessage(data) {
          messages.push(data.type);
        },
      },
    });
    for (let step = 0; step < ticks; step += 1) [...intervals.values()].forEach((fn) => fn());
    return { state, messages, intervals };
  }
  const opened = run(true, 4);
  assert.equal(opened.state.clicks, 1);
  assert.deepEqual(opened.messages, ["oss:dsh-settings-accepted"]);
  const missed = run(false, 41);
  assert.equal(missed.state.clicks, 0);
  assert.deepEqual(missed.messages, ["oss:dsh-settings-accepted", "oss:dsh-settings-failed"]);
  assert.equal(missed.intervals.size, 0);
});

test("surface manifest names the four thin server services", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schema, "dsh-surface-manifest-v1");
  assert.equal(manifest.phase, "3B-2");
  const thin = ["webServer", "connection", "llm", "attachments"];
  assert.deepEqual(manifest.server.targetThinShell, thin);
  // Phase 3B-2 is complete: the current server surface IS the thin shell.
  assert.deepEqual(
    manifest.server.current.map((row) => row.service),
    thin,
  );
  assert.deepEqual(manifest.client.targetThinShell, ["slots", "layout", "locale"]);
  const allowed = new Set(["keep-thin", "remove-after-core-loop"]);
  for (const row of [...manifest.server.current, ...manifest.client.current]) {
    assert.equal(typeof row.service, "string");
    assert.equal(Array.isArray(row.symbols) && row.symbols.length > 0, true, row.service);
    assert.equal(allowed.has(row.status), true, row.service);
  }
  for (const row of manifest.server.current) assert.equal(row.status, "keep-thin", row.service);
  for (const service of manifest.client.targetThinShell) {
    const row = manifest.client.current.find((item) => item.service === service);
    assert.equal(row?.status, "keep-thin", service);
  }
  assert.deepEqual(
    manifest.server.optional.map((row) => row.service),
    ["mcpManager"],
  );
  const removed = new Set(manifest.server.removed.map((row) => row.service));
  for (const service of [
    "tools",
    "agents",
    "agentPresets",
    "profileContext",
    "workspaceRegistry",
    "sessionQuery",
    "sessionProjections",
  ]) {
    assert.equal(removed.has(service), true, service);
  }
  assert.equal(manifest.server.removedEvents.includes("session/event"), true);
  assert.equal(Array.isArray(manifest.rc5Adaptations) && manifest.rc5Adaptations.length >= 4, true);
  assert.equal(
    manifest.rc5Adaptations.some((row) => row.id === "core-loop-cutover"),
    true,
  );
});

test("plugin server entry injects exactly the four thin services and never reaches DSH agent services", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dsh-slidestudio.ts", import.meta.url)), "utf8");
  const inject = source.match(/export const inject = (\[[^\]]*\])/);
  assert.ok(inject, "server inject literal");
  assert.deepEqual(JSON.parse(inject[1]), ["webServer", "connection", "llm", "attachments"]);
  for (const forbidden of ["profileContext", "agentPresets", "registerSlidesPreset", "ctx.agents", "ctx.tools"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const bundle = readFileSync(fileURLToPath(new URL("../lib/dsh-slidestudio.js", import.meta.url)), "utf8");
  assert.equal(bundle.includes('"profileContext"'), false);
  assert.equal(bundle.includes('"agentPresets"'), false);
});
