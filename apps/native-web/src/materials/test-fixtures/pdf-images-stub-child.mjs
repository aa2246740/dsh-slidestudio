/**
 * Stand-in for the PDF child processes, so their parents can be tested without
 * the optional native add-ons.
 *
 * As pdf-images-child.mjs (`{type: "extract"}`): the "PDF" it is given is JSON
 * choosing the behaviour: `ok` (stream pages, finish), `hang` (stream pages,
 * never finish), `crash` (exit at once) or `error` (report an encrypted file). A
 * plan with `reportEnvTo` first writes the names of the environment variables it
 * received to that file, so a test can see what the parent really passed.
 *
 * As pdf-render-child.mjs (`{type: "probe"}` / `{type: "render"}`): the probe
 * writes its environment variable names to `pdf-child-env.json` in its temp
 * directory (only reachable when TMPDIR crossed over) and reports a canvas; a
 * render waits briefly, like a real page paint, then writes a small JPEG-marked
 * page file into the parent's temp directory and answers with its descriptor.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Long enough for an injected RSS sampler to see (and freeze) the child first. */
const RENDER_DELAY_MS = 120;

/** @param {Record<string, unknown>} message @param {() => void} [done] */
const send = (message, done) => {
  if (!process.send) return process.exit(1);
  return done ? process.send(message, done) : process.send(message);
};

/** @param {Record<string, unknown>} message */
const reply = (message) => send(message, () => process.exit(message.ok === false ? 1 : 0));

/** @param {any} message */
function probe(message) {
  fs.writeFileSync(
    path.join(os.tmpdir(), "pdf-child-env.json"),
    JSON.stringify(Object.keys(process.env)),
  );
  reply({ ok: true, result: { available: true, type: message.type } });
}

/** @param {{pageIndex: number, tempDir: string}} message */
function render({ pageIndex, tempDir }) {
  setTimeout(() => {
    const file = `page-${pageIndex}.jpg`;
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(`stub page ${pageIndex}`, "latin1"),
      Buffer.from([0xff, 0xd9]),
    ]);
    fs.writeFileSync(path.join(tempDir, file), bytes, { flag: "wx" });
    reply({
      ok: true,
      result: {
        page: {
          index: pageIndex,
          file,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          px: { width: 960, height: 540 },
        },
        pageImage: { index: pageIndex, hasImage: pageIndex === 1, imageCoverage: 0.9 },
      },
    });
  }, RENDER_DELAY_MS);
}

/** @param {{filePath: string}} message */
function extract(message) {
  const plan = JSON.parse(fs.readFileSync(message.filePath, "utf8"));
  if (plan.reportEnvTo)
    fs.writeFileSync(plan.reportEnvTo, JSON.stringify(Object.keys(process.env)));
  const skipped = { small: 0, tooLarge: 0, duplicate: 0, unreadable: 0 };
  if (plan.mode === "crash") process.exit(3);
  if (plan.mode === "error") {
    send({ type: "error", code: "encrypted", message: "文件已加密，无法读取" }, () =>
      process.exit(1),
    );
    return;
  }
  let page = 0;
  const step = () => {
    page += 1;
    send({
      type: "page",
      page,
      pagesScanned: page,
      qualifying: page,
      skipped,
      images: [
        { page, order: 1, width: 64, height: 64, format: "png", bytes: Buffer.from([page]) },
      ],
    });
    if (page < plan.pages) return setTimeout(step, plan.gapMs ?? 20);
    if (plan.mode === "hang") return setInterval(() => {}, 1000);
    send(
      {
        type: "done",
        summary: {
          qualifying: page,
          countComplete: true,
          pagesScanned: page,
          pageCount: page,
          skipped,
          timedOut: false,
        },
      },
      () => process.exit(0),
    );
  };
  step();
}

process.on("message", (/** @type {any} */ message) => {
  if (message?.type === "probe") probe(message);
  else if (message?.type === "render") render(message);
  else extract(message);
});
