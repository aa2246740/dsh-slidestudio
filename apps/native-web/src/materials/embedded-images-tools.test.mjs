import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { AttachmentStore } from "../attachments.mjs";
import { readSample } from "./sample-fixtures.mjs";
import { editorAttachmentOf } from "./test-fixtures/material-harness.mjs";
import { runToolScript } from "./test-fixtures/material-tools-run.mjs";
import {
  docxWithTablePictures,
  docxWithWrappedPictures,
  env,
  ingest,
  NO_SAMPLES,
  NO_SHARP,
  runDocxPictureTools,
  sharp,
  useEmbeddedEnv,
} from "./test-fixtures/embedded-harness.mjs";

/** @typedef {import("../attachments.mjs").StoredRecord} StoredRecord */
/** @typedef {NonNullable<import("../attachments.mjs").StoredDerivative["document"]>} StoredDocument */
/** @typedef {import("./embedded-images.mjs").EmbeddedImagesSection} EmbeddedImagesSection */

useEmbeddedEnv();
/** @type {string} */ let samples;
/** @type {import("./parse-pool.mjs").ParsePool} */ let pool;
before(() => {
  ({ samples, pool } = env);
});

describe("VAL-PDF-007: real sidecar records through the real host tools", { skip: NO_SHARP }, () => {
  test(
    "view_material all-images numbers the DOCX and PDF pictures that intake stored",
    { skip: NO_SAMPLES },
    async () => {
      const owner = "browser-A";
      /** @type {string[]} */
      const expectedOrder = [];
      const run = await runToolScript({
        vision: true,
        steps: [
          { name: "list_materials", args: {} },
          { name: "view_material", args: { materialId: "all-images" } },
        ],
        fixtures: async (storeDir) => {
          const hostStore = new AttachmentStore(storeDir);
          const attachments = [];
          for (const name of ["report.docx", "photo-in.pdf"]) {
            const { record } = await ingest(name, readSample(samples, name), owner, {
              store: hostStore,
              pool,
            });
            const document = /** @type {StoredDocument} */ (record.derivative.document);
            const section = /** @type {EmbeddedImagesSection} */ (document.embeddedImages);
            const children = section.images.map((entry) => /** @type {StoredRecord} */ (hostStore.read(entry.id)));
            for (const entry of [record, ...children]) {
              attachments.push(editorAttachmentOf(entry));
            }
            expectedOrder.push(...children.map((child) => child.meta.id));
          }
          return attachments;
        },
      });
      try {
        const [listed, overview] = run.results.map((item) => JSON.parse(item.text));
        assert.equal(listed.ok, true, run.results[0].text);
        const notes = listed.payload.materials
          .filter((/** @type {{ kind: string; }} */ entry) => entry.kind === "image")
          .map((/** @type {{ summaryZh: string; }} */ entry) => entry.summaryZh.split(" · ")[0]);
        assert.deepEqual(notes, ["来自文档第 10 段", "来自 PDF 第 1 页", "来自 PDF 第 2 页"]);
        assert.ok(
          listed.payload.materials
            .filter((/** @type {{ kind: string; }} */ entry) => entry.kind === "image")
            .every(
              (/** @type {{ mediaSrc: string; styleProfile: any; }} */ entry) =>
                /^media\//.test(entry.mediaSrc) && entry.styleProfile,
            ),
          "each picture is placeable and carries its own style profile",
        );

        assert.equal(overview.ok, true, run.results[1].text);
        assert.equal(run.results[1].imageBlocks, 1);
        assert.deepEqual(
          overview.payload.overview.tiles.map((/** @type {{ materialId: any; }} */ tile) => tile.materialId),
          expectedOrder,
        );
        assert.equal(expectedOrder.length, 3);
        const mosaic = await sharp(run.saved[0].data).metadata();
        assert.equal(mosaic.format, "jpeg");
      } finally {
        await run.cleanup();
      }
    },
  );

  test("list_materials and the all-images overview include the pictures of a DOCX table", async () => {
    const { run, expectedOrder } = await runDocxPictureTools("tables.docx", await docxWithTablePictures());
    try {
      const [listed, overview] = run.results.map((item) => JSON.parse(item.text));
      assert.equal(listed.ok, true, run.results[0].text);
      const pictures = listed.payload.materials.filter(
        (/** @type {{ kind: string; }} */ entry) => entry.kind === "image",
      );
      assert.deepEqual(
        pictures.map((/** @type {{ summaryZh: string; }} */ entry) => entry.summaryZh.split(" · ")[0]),
        ["来自文档第 2 段", "来自文档第 1 个表格", "来自文档第 1 个表格"],
      );
      assert.ok(
        pictures.every(
          (/** @type {{ mediaSrc: string; styleProfile: any; }} */ entry) =>
            /^media\//.test(entry.mediaSrc) && entry.styleProfile,
        ),
        "each table picture is placeable and carries its own style profile",
      );

      assert.equal(overview.ok, true, run.results[1].text);
      assert.deepEqual(
        overview.payload.overview.tiles.map((/** @type {{ materialId: any; }} */ tile) => tile.materialId),
        expectedOrder,
      );
      assert.equal(expectedOrder.length, 3);
    } finally {
      await run.cleanup();
    }
  });

  test("list_materials and the all-images overview include the pictures of wrapped rows and cells", async () => {
    const { run, expectedOrder } = await runDocxPictureTools("wrapped.docx", await docxWithWrappedPictures());
    try {
      const [listed, overview] = run.results.map((item) => JSON.parse(item.text));
      assert.equal(listed.ok, true, run.results[0].text);
      const pictures = listed.payload.materials.filter(
        (/** @type {{ kind: string; }} */ entry) => entry.kind === "image",
      );
      assert.deepEqual(
        pictures.map((/** @type {{ summaryZh: string; }} */ entry) => entry.summaryZh.split(" · ")[0]),
        [
          "来自文档第 1 段",
          "来自文档第 1 个表格",
          "来自文档第 1 个表格",
          "来自文档第 2 个表格",
          "来自文档第 2 个表格",
          "来自文档第 3 个表格",
        ],
      );
      assert.ok(
        pictures.every(
          (/** @type {{ mediaSrc: string; styleProfile: any; }} */ entry) =>
            /^media\//.test(entry.mediaSrc) && entry.styleProfile,
        ),
        "each wrapped picture is placeable and carries its own style profile",
      );

      assert.equal(overview.ok, true, run.results[1].text);
      assert.deepEqual(
        overview.payload.overview.tiles.map((/** @type {{ materialId: any; }} */ tile) => tile.materialId),
        expectedOrder,
      );
      assert.equal(expectedOrder.length, 6);
    } finally {
      await run.cleanup();
    }
  });
});
