import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { persistPresentationRunProvider } from "@open-slidestudio/presentation-run";
import type { SlideToolDefinition } from "./contract.js";
import { ImageCodecUnavailableError, loadImageCodec, setImageCodecLoader } from "./image-codec.js";
import { composeImageOverview } from "./image-overview.js";
import { createSlideTools } from "./suite.js";
import { contextFor, makeProject, recordingPresentation, runtimeDeps } from "./testkit.js";

afterEach(() => setImageCodecLoader(undefined));

const missingCodec = () => Promise.reject(new Error("Cannot find module 'sharp'"));

function materialTools(reply: Parameters<typeof recordingPresentation>[0]) {
  const { presentation, calls } = recordingPresentation(reply);
  const byName = new Map<string, SlideToolDefinition>(
    createSlideTools(runtimeDeps(presentation)).map((tool) => [tool.name, tool]),
  );
  return { byName, calls };
}

function visionProject(acceptsImages: boolean): string {
  const root = makeProject([]);
  fs.mkdirSync(path.join(root, "_agent"), { recursive: true });
  fs.writeFileSync(path.join(root, "_agent", "presentation-run.v1.json"), JSON.stringify({ version: 1 }));
  const persisted = persistPresentationRunProvider(root, {
    providerId: "test",
    modelId: "vision-model",
    ready: true,
    modelInputModalities: acceptsImages ? ["text", "image"] : ["text"],
  });
  assert.equal(persisted, true);
  return root;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

test("view_material returns the picture as a neutral image block and strips raw bytes from data", async () => {
  const root = visionProject(true);
  const { byName, calls } = materialTools((command) =>
    command.name === "view_material"
      ? { payload: { materialId: "img-1", kind: "image", imageBytesBase64: JPEG.toString("base64") } }
      : {},
  );
  const out = await byName.get("view_material")!.execute({ materialId: "img-1" }, contextFor(root));
  assert.equal(out.data.ok, true);
  assert.equal("imageBytesBase64" in (out.data.payload as Record<string, unknown>), false);
  assert.equal(out.content?.length, 1);
  const block = out.content![0]!;
  assert.ok(block.type === "image");
  assert.equal(block.mediaType, "image/jpeg");
  assert.equal(block.name, "img-1.jpg");
  assert.deepEqual(Buffer.from(block.data), JPEG);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["view_material"],
  );
});

test("view_material and record_material_notes refuse a text-only model without calling the domain", async () => {
  const root = visionProject(false);
  const { byName, calls } = materialTools(() => ({}));
  const viewed = await byName.get("view_material")!.execute({ materialId: "img-1" }, contextFor(root));
  assert.equal((viewed.data.payload as Record<string, unknown>).error, "vision_unavailable");
  assert.equal(viewed.content, undefined);
  const noted = await byName
    .get("record_material_notes")!
    .execute({ materialId: "img-1", caption: "封面照片", suggestedUse: "page" }, contextFor(root));
  assert.equal((noted.data.payload as Record<string, unknown>).error, "vision_unavailable");
  assert.deepEqual(calls, []);
});

test("record_material_notes forwards the notes for an image-capable model", async () => {
  const root = visionProject(true);
  const { byName, calls } = materialTools(() => ({ payload: { recorded: true } }));
  const args = { materialId: "img-1", caption: "封面照片", suggestedUse: "page", focus: [0.5, 0.4] };
  const out = await byName.get("record_material_notes")!.execute(args, contextFor(root));
  assert.equal(out.data.ok, true);
  assert.deepEqual(calls, [{ name: "record_material_notes", args }]);
});

test("a host that cannot deliver images fails view_material closed with an explicit reason", async () => {
  const root = visionProject(true);
  const { byName } = materialTools(() => ({
    payload: { materialId: "img-1", kind: "image", imageBytesBase64: JPEG.toString("base64") },
  }));
  await assert.rejects(
    byName.get("view_material")!.execute({ materialId: "img-1" }, { ...contextFor(root), acceptsImageContent: false }),
    /attachments service is not mounted/,
  );
});

test("image-overview degrades to a typed refusal when the image codec is unavailable", async () => {
  setImageCodecLoader(missingCodec);
  await assert.rejects(loadImageCodec(), ImageCodecUnavailableError);
  await assert.rejects(composeImageOverview([{ number: 1, bytes: JPEG }]), ImageCodecUnavailableError);

  const root = visionProject(true);
  const dir = path.join(root, "_agent", "materials", "img-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "original.jpg"), JPEG);
  const sha256 = crypto.createHash("sha256").update(JPEG).digest("hex");
  const overviewPlan = {
    kind: "all-images",
    materialId: "all-images",
    name: "全部图片",
    total: 1,
    truncated: false,
    tiles: [{ number: 1, materialId: "img-1", name: "cover.jpg", file: "_agent/materials/img-1/original.jpg", sha256 }],
  };
  const { byName, calls } = materialTools((command) =>
    command.name === "view_material" ? { payload: { overviewPlan } } : {},
  );
  const out = await byName.get("view_material")!.execute({ materialId: "all-images" }, contextFor(root));
  assert.equal(out.data.ok, false);
  assert.equal((out.data.payload as Record<string, unknown>).error, "image_codec_unavailable");
  assert.match(String(out.data.detail), /sharp/);
  assert.equal(out.content, undefined, "no image block is streamed");
  assert.deepEqual(
    calls.map((call) => call.name),
    ["view_material"],
    "the overview is not recorded as viewed",
  );
});

test("a deck-template photo degrades with a Chinese reason when the codec is unavailable", async () => {
  setImageCodecLoader(missingCodec);
  const root = visionProject(true);
  const { byName } = materialTools(() => ({
    payload: { materialId: "tpl-1", kind: "deck-template", imageBytesBase64: JPEG.toString("base64") },
  }));
  const out = await byName.get("view_material")!.execute({ materialId: "tpl-1", mediaId: "photo-1" }, contextFor(root));
  assert.equal(out.data.ok, false);
  assert.equal((out.data.payload as Record<string, unknown>).error, "image_codec_unavailable");
  assert.equal(out.content, undefined);
});

test("list_materials, read_material and query_material are read-only pass-throughs", async () => {
  const root = makeProject([]);
  const { byName, calls } = materialTools(() => ({ payload: { rows: [] } }));
  for (const name of ["list_materials", "read_material", "query_material"]) {
    assert.equal(byName.get(name)!.readOnly, true, name);
  }
  const query = {
    materialId: "sales",
    part: "rows",
    groupBy: ["区域"],
    measures: [{ op: "sum", column: "收入", as: "收入合计" }],
  };
  const out = await byName.get("query_material")!.execute(query, contextFor(root));
  assert.equal(out.data.ok, true);
  assert.deepEqual(calls, [{ name: "query_material", args: query }]);
  assert.equal(fs.existsSync(path.join(root, "_agent", "writer-lease.v1.json")), false);
});
