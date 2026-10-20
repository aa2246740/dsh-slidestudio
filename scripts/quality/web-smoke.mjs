import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { ROOT } from "./source-files.mjs";

/**
 * Dynamic security probe for the legacy web dev server: boots `vite` on a free
 * port, then asserts the live endpoints answer safely — health probe works,
 * HTML is served, traversal outside the webroot is refused, and no remote
 * script origins are injected into the shell.
 */
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const child = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--strictPort", "--port", String(freePort)],
  { cwd: path.join(ROOT, "apps/web"), stdio: ["ignore", "pipe", "inherit"] },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let timer;
const get = (p, opts) => fetch(`http://127.0.0.1:${freePort}${p}`, opts);
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("vite dev server did not accept connections")), 20000);
    child.once("exit", () => reject(new Error("vite exited before readiness")));
    (async () => {
      for (let i = 0; i < 80; i++) {
        try {
          if ((await get("/health.json")).status === 200) return resolve();
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      reject(new Error("health probe never returned 200"));
    })();
  });

  let failed = 0;
  const check = (label, ok, detail = "") => {
    if (ok) console.log(`  ok  ${label}`);
    else {
      failed += 1;
      console.error(`  FAIL ${label} ${detail}`);
    }
  };

  const health = await get("/health.json");
  const healthBody = await health.json();
  check("/health.json 200 + status ok", health.status === 200 && healthBody.status === "ok");

  const root = await get("/");
  const html = await root.text();
  check("/ serves HTML shell", root.status === 200 && /<div id="root">/.test(html));
  check("no remote script origins", !/<script[^>]+src=["']https?:\/\//.test(html));

  const traversal = await get("/../../package.json");
  check("path traversal refused", traversal.status !== 200 || !(await traversal.text()).includes('"workspaces"'));

  const hostile = await get("/%2e%2e/%2e%2e/etc/passwd");
  check("encoded traversal refused", hostile.status !== 200 || !(await hostile.text()).includes("root:"));

  if (failed) {
    console.error(`web-smoke: ${failed} probe(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("web-smoke: live endpoint probes passed");
  }
} finally {
  clearTimeout(timer);
  child.kill("SIGINT");
  await exited;
}
