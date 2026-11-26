import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mountHubAttachments } from "../public/hub-attachments.js";
import { VISION_NOTICE_TEXT } from "../public/vision-notice.js";
import {
  FakeXHR,
  HUB_MARKUP,
  fileLike,
  installDom,
  jsonResponse,
  query,
  required,
  textOf,
  tick,
} from "./attachment-dom-harness.test.mjs";

/** @typedef {import("./attachment-dom-harness.test.mjs").FetchImpl} FetchImpl */

const PROVIDER = "local-llm";
const TEXT_MODEL = "text-1";
const VISION_MODEL = "vision-1";
const HUB_WITH_PANEL = HUB_MARKUP.replace(
  '<button id="btn-model"></button>',
  '<button id="btn-model"></button><div id="pi-panel" hidden><ul id="capability-row" hidden></ul></div>',
);
/** @param {string} provider @param {{id: string, inputModalities?: readonly string[]}[]} models */
const modelsBody = (provider, models) => [{ providerId: provider, providerName: provider, ready: true, models }];
const MODELS_REPLY = modelsBody(PROVIDER, [
  { id: TEXT_MODEL, inputModalities: ["text"] },
  { id: VISION_MODEL, inputModalities: ["text", "image"] },
]);
/** @param {string} provider @param {string} model @param {boolean | undefined} accepts */
const healthBody = (provider, model, accepts) => ({
  ok: true,
  selection: { providerId: provider, model, ready: true },
  capability: { vision: accepts === undefined ? {} : { modelAcceptsImages: accepts } },
});
const PARSED_IMAGE = {
  id: "att-png",
  name: "团队合影.png",
  size: 1200,
  kind: "image",
  status: "parsed",
  parser: "image-sharp-v1",
  summary: { zh: "PNG 图片 · 1600×1000 · 主色 #1E6FD9" },
  warnings: [],
  needsVision: true,
};
const PARSED_TABLE = {
  ...PARSED_IMAGE,
  id: "att-xlsx",
  name: "季度经营.xlsx",
  kind: "table",
  parser: "xlsx-ooxml-v1",
  needsVision: false,
};

/** @type {ReturnType<typeof installDom> | null} */
let env = null;
/** @type {FetchImpl} */
let route = async (url) =>
  String(url).startsWith("/slides/models") ? jsonResponse(MODELS_REPLY) : jsonResponse({}, 404);
let modelClicks = 0;
afterEach(async () => {
  await env?.restore();
  env = null;
});

/** @param {Partial<Parameters<typeof mountHubAttachments>[0]>} [options] */
function setupHub(options = {}) {
  modelClicks = 0;
  route = async (url) =>
    String(url).startsWith("/slides/models") ? jsonResponse(MODELS_REPLY) : jsonResponse({}, 404);
  env = installDom(HUB_WITH_PANEL, { url: "http://hub.test/", fetchImpl: (url, init) => route(url, init) });
  required("btn-model").addEventListener("click", () => {
    modelClicks += 1;
    required("pi-panel").hidden = false;
  });
  return mountHubAttachments({ onChange: () => {}, onMessage: () => {}, ...options });
}

/** Pick one file and let its upload return `record`. @param {{name: string}} record */
function addParsedChip(record) {
  const marker = FakeXHR.instances.length;
  const input = required("attach-file");
  Object.defineProperty(input, "files", { configurable: true, value: [fileLike(record.name, 1)] });
  input.dispatchEvent(new (env?.win.Event ?? Event)("change"));
  const request = FakeXHR.instances[marker];
  assert.ok(request);
  request.progress(1, 1);
  request.uploaded();
  request.finish(200, record);
}
const ticks = async (count = 4) => {
  for (let index = 0; index < count; index += 1) await tick();
};
const noticeEl = () => required("vision-notice");
const panelNotice = () => query(document, "#pi-panel .vision-notice");
const chipVisionMarks = () => [...document.querySelectorAll("#attach-row .chip-vision-note")];
/** @param {string} url */
const params = (url) => new URL(url, "http://hub.test").searchParams;

test("hub: needsVision chip + text-only model shows the notice on the chip and near the capability row", async () => {
  const attachments = setupHub();
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks();
  const notice = noticeEl();
  assert.equal(notice.hidden, false);
  assert.equal(notice.getAttribute("role"), "status");
  assert.ok(textOf(notice).includes(VISION_NOTICE_TEXT));
  assert.match(textOf(notice), /尺寸、主色/);
  assert.equal(query(notice, "[data-control]").dataset.control, "chrome.createhub.attach.vision.models");
  const mirror = panelNotice();
  assert.equal(mirror.hidden, false);
  assert.match(textOf(mirror), /当前模型无法识别图片内容/);
  assert.equal(mirror.previousElementSibling?.id, "capability-row");
  assert.equal(chipVisionMarks().length, 1);
});

test("hub: switching to a vision model hides the notice; removing the image hides it too", async () => {
  const attachments = setupHub();
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks();
  assert.equal(noticeEl().hidden, false);
  attachments.setModel({ provider: PROVIDER, model: VISION_MODEL });
  await ticks();
  assert.equal(noticeEl().hidden, true);
  assert.equal(panelNotice().hidden, true);
  assert.equal(chipVisionMarks().length, 0);
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  await ticks();
  assert.equal(noticeEl().hidden, false);
  query(document, "#attach-row .chip-remove").click();
  await ticks();
  assert.equal(noticeEl().hidden, true);
});

test("hub: no notice when the model cannot see but only non-vision attachments exist", async () => {
  const attachments = setupHub();
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_TABLE);
  await ticks();
  assert.equal(noticeEl().hidden, true);
});

test("hub: a slow models response still lands on the current selection, and the action opens the picker", async () => {
  const attachments = setupHub();
  /** @type {(response: Response) => void} */
  let resolveModels = () => {};
  route = (url) =>
    String(url).startsWith("/slides/models")
      ? new Promise((resolve) => {
          resolveModels = resolve;
        })
      : Promise.resolve(jsonResponse({}, 404));
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  attachments.setModel({ provider: PROVIDER, model: VISION_MODEL });
  resolveModels(jsonResponse(MODELS_REPLY));
  await ticks(8);
  assert.equal(noticeEl().hidden, true);
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  await ticks();
  assert.equal(noticeEl().hidden, false);
  query(noticeEl(), "[data-control]").click();
  assert.equal(modelClicks, 1);
  assert.equal(required("pi-panel").hidden, false);
});

test("hub: the notice action prefers the picker-open callback over a raw trigger click", async () => {
  let opened = 0;
  const attachments = setupHub({
    onOpenModels: () => {
      opened += 1;
      required("pi-panel").hidden = false;
    },
  });
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks(8);
  assert.equal(noticeEl().hidden, false);
  query(noticeEl(), "[data-control]").click();
  assert.equal(opened, 1);
  assert.equal(modelClicks, 0);
  assert.equal(required("pi-panel").hidden, false);
});

test("hub: an explicit capability from the picker skips the health round trip", async () => {
  const attachments = setupHub();
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL, modelAcceptsImages: false });
  addParsedChip(PARSED_IMAGE);
  await ticks();
  assert.equal(noticeEl().hidden, false);
  assert.equal(attachments.sendState({ briefFilled: true }).disabled, false, "the notice never blocks sending");
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL, modelAcceptsImages: null });
  await ticks();
  assert.equal(noticeEl().hidden, true, "unknown is not a warning");
  assert.equal(env?.fetchMock.mock.calls.filter((call) => String(call.arguments[0]).startsWith("/slides/")).length, 0);
});

test("hub: flash stays unmarked after an unknown capability is replaced by image input", async () => {
  const attachments = setupHub();
  /** @type {readonly string[]} */
  let visionModes = [];
  /** @type {boolean | undefined} */
  let visionAccepts;
  route = async (url) => {
    if (url.startsWith("/slides/models")) {
      return jsonResponse(
        modelsBody(PROVIDER, [
          { id: TEXT_MODEL, inputModalities: ["text"] },
          { id: VISION_MODEL, inputModalities: visionModes },
        ]),
      );
    }
    if (url.startsWith("/slides/health")) {
      const model = params(url).get("model") || "";
      return jsonResponse(healthBody(PROVIDER, model, model === VISION_MODEL ? visionAccepts : false));
    }
    return jsonResponse({}, 404);
  };
  attachments.setModel({ provider: PROVIDER, model: VISION_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks(8);
  assert.equal(noticeEl().hidden, true, "unknown or empty modalities must not warn");
  assert.equal(chipVisionMarks().length, 0);
  visionModes = ["text", "image"];
  visionAccepts = true;
  attachments.syncVision();
  await ticks(8);
  assert.equal(noticeEl().hidden, true);
  assert.equal(panelNotice().hidden, true);
  assert.equal(chipVisionMarks().length, 0);
});

test("hub: the same model id is judged per provider", async () => {
  const attachments = setupHub();
  route = async (url) => {
    if (url.startsWith("/slides/models")) {
      return jsonResponse([
        ...modelsBody(PROVIDER, [{ id: TEXT_MODEL, inputModalities: ["text"] }]),
        ...modelsBody("other", [{ id: TEXT_MODEL, inputModalities: ["text", "image"] }]),
      ]);
    }
    if (url.startsWith("/slides/health")) {
      const provider = params(url).get("provider") || "";
      return jsonResponse(healthBody(provider, params(url).get("model") || "", provider === "other"));
    }
    return jsonResponse({}, 404);
  };
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks(8);
  assert.equal(noticeEl().hidden, false);
  assert.equal(chipVisionMarks().length, 1);
  attachments.setModel({ provider: "other", model: TEXT_MODEL });
  await ticks(8);
  assert.equal(noticeEl().hidden, true);
  assert.equal(chipVisionMarks().length, 0);
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  await ticks(8);
  assert.equal(noticeEl().hidden, false);
});

test("hub: a late text-only health response does not mark the vision model", async () => {
  const attachments = setupHub();
  /** @type {Map<string, (response: Response) => void>} */
  const pending = new Map();
  route = (url) => {
    if (url.startsWith("/slides/health")) {
      return new Promise((resolve) => pending.set(params(url).get("model") || "", resolve));
    }
    if (url.startsWith("/slides/models")) {
      return Promise.resolve(
        jsonResponse(
          modelsBody(PROVIDER, [
            { id: TEXT_MODEL, inputModalities: ["text"] },
            { id: VISION_MODEL, inputModalities: [] },
          ]),
        ),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  };
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks(2);
  attachments.setModel({ provider: PROVIDER, model: VISION_MODEL });
  await ticks(2);
  const resolveVision = pending.get(VISION_MODEL);
  assert.ok(resolveVision, "vision health was requested");
  resolveVision(jsonResponse(healthBody(PROVIDER, VISION_MODEL, true)));
  await ticks(8);
  assert.equal(noticeEl().hidden, true);
  const resolveText = pending.get(TEXT_MODEL);
  assert.ok(resolveText, "the earlier text-model health was requested");
  resolveText(jsonResponse(healthBody(PROVIDER, TEXT_MODEL, false)));
  await ticks(8);
  assert.equal(noticeEl().hidden, true, "stale health must not flip the current model");
  assert.equal(chipVisionMarks().length, 0);
  assert.equal(panelNotice().hidden, true);
});

test("hub: health false shows the notice when the catalog has no modality list", async () => {
  const attachments = setupHub();
  route = async (url) => {
    if (url.startsWith("/slides/health")) {
      const model = params(url).get("model") || "";
      return jsonResponse(healthBody(PROVIDER, model, model === VISION_MODEL));
    }
    if (url.startsWith("/slides/models")) return jsonResponse([]);
    return jsonResponse({}, 404);
  };
  attachments.setModel({ provider: PROVIDER, model: TEXT_MODEL });
  addParsedChip(PARSED_IMAGE);
  await ticks(8);
  assert.equal(noticeEl().hidden, false);
  assert.equal(chipVisionMarks().length, 1);
  query(noticeEl(), "[data-control]").click();
  assert.equal(modelClicks, 1);
});
