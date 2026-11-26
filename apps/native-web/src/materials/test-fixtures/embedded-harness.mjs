/**
 * Shared state and fixtures for the VAL-PDF-007 embedded-image suites: one store, one parse pool
 * and the generated samples per test file, plus DOCX picture builders and the material-tool run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";
import { AttachmentStore } from "../../attachments.mjs";
import { loadOptionalNative } from "../../optional-native.mjs";
import { ingestAttachment } from "../intake.mjs";
import { ParsePool } from "../parse-pool.mjs";
import { sharedPdfImages } from "../pdf-images-run.mjs";
import { generateSamples, SAMPLES_SKIP } from "../sample-fixtures.mjs";
import {
  cellOf,
  customXmlOf,
  docxWithBody,
  pictureParagraph,
  rowOf,
  rowRaw,
  sdtOf,
  tableOf,
  tableRaw,
  textParagraph,
} from "./docx-media.mjs";
import { editorAttachmentOf } from "./material-harness.mjs";
import { runToolScript } from "./material-tools-run.mjs";

/**
 * The suites pass an owner to intake and reads; this store does not scope by owner and ignores it.
 * @typedef {import("../intake.mjs").Upload & {ownerId: string}} OwnedUpload
 * @typedef {{read: (id: string, options: {ownerId: string}) => ReadRecord|undefined}} OwnerReads
 * @typedef {import("../../attachments.mjs").ReadRecord} ReadRecord
 * @typedef {import("../embedded-images.mjs").EmbeddedImagesSection} EmbeddedImagesSection
 */

/** @type {any} sharp's default export when the optional decoder is installed. */
export const sharp = await loadOptionalNative("sharp");
/** Picture extraction decodes with sharp; without it these suites are skipped, not failed. */
export const NO_SHARP = sharp ? false : "sharp is not installed";
/** Tests that read a generated contract sample also need the sample generator. */
export const NO_SAMPLES = SAMPLES_SKIP;

/** Filled by the `before` hook of {@link useEmbeddedEnv}. */
export const env = /** @type {{samples: string, scratch: string, store: AttachmentStore, pool: ParsePool}} */ ({});
let owner = 0;
export const nextOwner = () => `owner-embedded-${++owner}`;

/** Registers the per-file store, pool and samples; call once at the top of a suite file. */
export function useEmbeddedEnv() {
  before(async () => {
    env.samples = SAMPLES_SKIP ? "" : await generateSamples();
    env.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oss-embedded-images-"));
    env.store = new AttachmentStore(path.join(env.scratch, "attachments"));
    env.pool = new ParsePool();
  });
  after(async () => {
    await env.pool?.close();
    if (env.scratch) fs.rmSync(env.scratch, { recursive: true, force: true });
  });
  return env;
}

/** PDFs go through the real extraction child process unless a test injects its own runner. */
export const ingest = (
  /** @type {string} */ name,
  /** @type {Buffer<ArrayBufferLike>} */ bytes,
  /** @type {string} */ ownerId,
  io = {},
) =>
  ingestAttachment(
    { store: env.store, pool: env.pool, pdfImages: sharedPdfImages, ...io },
    /** @type {OwnedUpload} */ ({ name, bytes, ownerId }),
  );

/** @param {string} ownerId @param {string} id */
export const readChild = (ownerId, id) => {
  const child = /** @type {OwnerReads} */ (env.store).read(id, { ownerId });
  assert.ok(child, `child ${id} is stored for its owner`);
  return child;
};

/** Pool wrapper that records every job and how many ran at once. */
export function recordingPool() {
  const inner = new ParsePool();
  /** @type {string[]} */
  const jobs = [];
  const run = inner.run.bind(inner);
  const seen = { inFlight: 0, maxInFlight: 0 };
  inner.run = async (job) => {
    jobs.push(/** @type {typeof job & {task?: string}} */ (job).task ?? job.name);
    seen.inFlight += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    try {
      return await run(job);
    } finally {
      seen.inFlight -= 1;
    }
  };
  return {
    pool: inner,
    jobs,
    get maxInFlight() {
      return seen.maxInFlight;
    },
  };
}

/**
 * @param {number} width
 * @param {number} height
 * @param {string} color
 */
export async function photo(width, height, color, format = "png") {
  const image = sharp({ create: { width, height, channels: 3, background: color } });
  return format === "jpeg" ? image.jpeg().toBuffer() : image.png().toBuffer();
}

/** A DOCX with a picture in body paragraph 2 and two pictures in the cells of its one table. */
export async function docxWithTablePictures() {
  const [body, first, second] = await Promise.all([
    photo(120, 80, "#2E6FD8"),
    photo(90, 90, "#B5573A"),
    photo(64, 100, "#467343"),
  ]);
  const xml = [textParagraph("正文"), pictureParagraph(0), tableOf([[pictureParagraph(1), pictureParagraph(2)]])].join(
    "",
  );
  return docxWithBody(xml, [
    { name: "body.png", bytes: body },
    { name: "cell-a.png", bytes: first },
    { name: "cell-b.png", bytes: second },
  ]);
}

/**
 * A DOCX whose six pictures sit in the wrappers Word writes around blocks, rows and cells: a
 * body content control, a row-level content control, a cell-level content control, and
 * customXml around a row whose cell holds a customXml paragraph.
 */
export async function docxWithWrappedPictures() {
  const colors = ["#2E6FD8", "#B5573A", "#467343", "#D97757", "#1A1917", "#6D6A62"];
  const pictures = await Promise.all(colors.map((color) => photo(96, 72, color)));
  const xml = [
    sdtOf(pictureParagraph(0)),
    tableRaw(
      sdtOf(rowOf([pictureParagraph(1), textParagraph("文字")]) + rowOf([textParagraph("甲"), pictureParagraph(2)])),
    ),
    tableRaw(rowRaw(sdtOf(cellOf(pictureParagraph(3))) + cellOf(pictureParagraph(4)))),
    tableRaw(customXmlOf(rowOf([customXmlOf(pictureParagraph(5))]))),
  ].join("");
  return docxWithBody(
    xml,
    pictures.map((bytes, index) => ({ name: `wrapped-${index}.png`, bytes })),
  );
}

/**
 * Uploads a DOCX through the real intake (real store and parse pool), then runs list_materials
 * and the all-images overview over its record and its pictures. The fixtures put the uploaded
 * record and its pictures into the tool store, in upload order.
 * @param {string} name @param {Buffer} bytes
 */
export async function runDocxPictureTools(name, bytes) {
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
      const { record } = await ingest(name, bytes, owner, { store: hostStore, pool: env.pool });
      const embedded = /** @type {{document: {embeddedImages: EmbeddedImagesSection}}} */ (record.derivative).document
        .embeddedImages;
      // Intake stores every picture it registers, so each read returns a record.
      const children = /** @type {ReadRecord[]} */ (
        embedded.images.map((entry) => /** @type {OwnerReads} */ (hostStore).read(entry.id, { ownerId: owner }))
      );
      const attachments = [];
      for (const entry of [record, ...children]) {
        attachments.push(editorAttachmentOf(entry));
      }
      expectedOrder.push(...children.map((child) => child.meta.id));
      return attachments;
    },
  });
  return { run, expectedOrder };
}
