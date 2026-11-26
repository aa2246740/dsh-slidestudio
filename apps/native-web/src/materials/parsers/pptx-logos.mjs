import { createHash } from "node:crypto";
import { imageFullyDecodes, MATERIAL_MAX_LOGO_BYTES } from "../logo-bytes.mjs";
import { boxArray, clampBox } from "./pptx-geometry.mjs";
import { DECODER_UNAVAILABLE, loadSharp } from "../optional-decoder.mjs";
/** @typedef {import("../optional-decoder.mjs").SharpCtor} SharpCtor */
/** @typedef {import("./pptx-geometry.mjs").Box} Box */
/** @typedef {{sourcePart:string,role:string,box:Box,clamped?:boolean}} Placement */
/** @typedef {{roles:Set<string>,boxes:Box[],placements:Placement[],grayscale?:boolean}} MediaUse */
/** @typedef {{id:string,part:string,bytes:number,format:string,width?:number,height?:number,roles:string[],logoCandidate:boolean,sha256?:string,placements?:Placement[],logoUndecodable?:boolean}} MediaEntry */
/** @typedef {{master:string,slides:number[]}} LayoutUse */
/** @typedef {{mediaId:string,px:number[],usedOnLayouts:string[],slidesCovered:number,box?:number[],clamped:boolean,primary:boolean,sha256?:string}} Logo */
/** @typedef {{mediaId:string,file:string,processed?:{file:string,ops:string[],sha256:string}}} Photo */
/** @typedef {{file:string,encoding:string,content:string}} Asset */
/** @param {Uint8Array} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {{code:string,message:string}[]} warnings */
export function ensureWdpWarning(warnings) {
  if (warnings.some((warning) => warning.code === "unsupported-wdp")) return;
  warnings.push({
    code: "unsupported-wdp",
    message: "已跳过无法读取的 WDP 图片；其余图片继续处理",
  });
}

/**
 * The derived grey of pictures that are not template photos is stored inside the derivative,
 * which has a hard size cap; past this total the remaining ones are skipped rather than letting
 * a few large layout photos make the whole template unreadable.
 */
export const CHROME_GREY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The grey copies of slide photos share their own total. They are base64 inside the derivative,
 * which is copied through every stage of intake (about 15 MB of server memory per MiB kept
 * here); photos past the total keep their original and ship no grey copy. A deck above the old
 * 20 MiB upload limit gets the smaller total, so a 35 MB template stays well inside the
 * sidecar's memory allowance (measured growth about 250 MB, against about 390 MB without it).
 */
export const SLIDE_GREY_MAX_BYTES = 12 * 1024 * 1024;
export const LARGE_DECK_BYTES = 20 * 1024 * 1024;
export const LARGE_DECK_SLIDE_GREY_MAX_BYTES = 3 * 1024 * 1024;

/**
 * The derived file is named after the whole media identity, extension included, so same.png and
 * same.jpeg stay two files; `/` is flattened as the kit does for originals, because the Host
 * accepts a single path segment below `photos/`. A name already taken (`a/b.png` against `a_b.png`,
 * or two names that differ only in case) gets a counter instead of replacing the first file.
 * @param {string} id @param {Set<string>} taken
 */
function derivedName(id, taken) {
  const stem = `photos/${id.replaceAll("/", "_")}-grayscale`;
  let name = `${stem}.png`;
  for (let count = 2; taken.has(name.toLowerCase()); count += 1) name = `${stem}-${count}.png`;
  taken.add(name.toLowerCase());
  return name;
}

/** @param {SharpCtor} decode @param {Uint8Array} bytes @param {string} id @param {number} room
 * @param {Set<string>} taken
 * @returns {Promise<{processed: NonNullable<Photo["processed"]>, asset: Asset, png: number}|null>} */
async function desaturate(decode, bytes, id, room, taken) {
  try {
    const png = await decode(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).grayscale().png().toBuffer();
    if (png.length > room) return null;
    const file = derivedName(id, taken);
    return {
      processed: { file, ops: ["grayscale"], sha256: hash(png) },
      asset: { file, encoding: "base64", content: png.toString("base64") },
      png: png.length,
    };
  } catch {
    return null;
  }
}

/**
 * Derives the grey of one picture and files it: a slide photo goes to `photos` against
 * `slideRoom` (with a warning, once, when the derivation fails or the budget is spent), any
 * other desaturated picture to `chromePhotos` against `room`.
 * @param {{decode: SharpCtor, photos: Photo[], chromePhotos: Photo[], assets: Asset[],
 *   warnings: {code:string,message:string}[], room: number, slideRoom: number, names: Set<string>}} into
 * @param {{id: string, part: string, bytes: Uint8Array, slidePhoto: boolean}} picture
 */
async function addGrey(into, { id, part, bytes, slidePhoto }) {
  const photo = /** @type {Photo} */ ({ mediaId: id, file: part });
  const grey = await desaturate(into.decode, bytes, id, slidePhoto ? into.slideRoom : into.room, into.names);
  if (grey) {
    photo.processed = grey.processed;
    into.assets.push(grey.asset);
    if (slidePhoto) into.slideRoom -= grey.png;
    else into.room -= grey.png;
  } else if (slidePhoto && !into.warnings.some((w) => w.code === "photo-processing-failed")) {
    into.warnings.push({
      code: "photo-processing-failed",
      message: "部分模板照片无法去色，已保留原图",
    });
  }
  (slidePhoto ? into.photos : into.chromePhotos).push(photo);
}

/** @param {{chromeGreyMaxBytes?: number, slideGreyMaxBytes?: number}} options @param {number} packageBytes */
function greyBudgets(options, packageBytes) {
  const slide = packageBytes > LARGE_DECK_BYTES ? LARGE_DECK_SLIDE_GREY_MAX_BYTES : SLIDE_GREY_MAX_BYTES;
  return {
    room: options.chromeGreyMaxBytes ?? CHROME_GREY_MAX_BYTES,
    slideRoom: options.slideGreyMaxBytes ?? slide,
  };
}

/**
 * Real dimensions and format of one media part, or the extension alone when it does not decode
 * (or no decoder is installed): unknown or corrupt media retain metadata, never invented pixels.
 * @param {SharpCtor|null} decode @param {Uint8Array} bytes @param {string} format
 */
async function probeMedia(decode, bytes, format) {
  if (!decode) return { width: undefined, height: undefined, format };
  try {
    const meta = await decode(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).metadata();
    return { width: meta.width, height: meta.height, format: meta.format ?? format };
  } catch {
    return { width: undefined, height: undefined, format };
  }
}

/** @param {Map<string,LayoutUse>} layouts @param {MediaUse|undefined} use */
function layoutPartsOf(layouts, use) {
  return [...layouts].filter(([part, value]) =>
    use?.placements.some(
      (p) => (p.role === "layout" && p.sourcePart === part) || (p.role === "master" && p.sourcePart === value.master),
    ),
  );
}

/**
 * @param {{id: string, width?: number, height?: number, placements: Placement[], decoded: boolean,
 *   bytes: Uint8Array}} item @param {Map<string,LayoutUse>} layouts @param {MediaUse|undefined} use
 * @returns {Logo}
 */
function logoOf({ id, width, height, placements, decoded, bytes }, layouts, use) {
  const layoutParts = layoutPartsOf(layouts, use);
  const slides = new Set(layoutParts.flatMap(([, value]) => value.slides));
  const box = placements[0]?.box;
  return {
    mediaId: id,
    px: [width ?? 0, height ?? 0],
    usedOnLayouts: layoutParts.filter(([, value]) => value.slides.length).map(([part]) => part),
    slidesCovered: slides.size,
    ...(box ? { box: boxArray(box) } : {}),
    clamped: placements.some((p) => p.clamped),
    primary: false,
    ...(decoded ? { sha256: hash(bytes) } : {}),
  };
}

/** @param {MediaUse|undefined} use @returns {Placement[]} */
function clampedPlacements(use) {
  return use?.placements.map((p) => ({ ...p, box: clampBox(p.box), clamped: clampBox(p.box).clamped })) ?? [];
}

/**
 * The first logo by layout reach, then area, whose bytes decoded and fit the logo cap.
 * @param {Logo[]} logos @param {MediaEntry[]} media
 */
function selectPrimary(logos, media) {
  logos.sort(
    (a, b) =>
      b.usedOnLayouts.length - a.usedOnLayouts.length ||
      (b.px[0] ?? 0) * (b.px[1] ?? 0) - (a.px[0] ?? 0) * (a.px[1] ?? 0) ||
      a.mediaId.localeCompare(b.mediaId),
  );
  const primary = logos.find((logo) =>
    media.some((item) => item.id === logo.mediaId && item.sha256 && item.bytes <= MATERIAL_MAX_LOGO_BYTES),
  );
  if (primary) primary.primary = true;
  // Existing stores and Host hand off one file, selected by the first flagged media.
  // All candidates remain in logos; later multi-logo materialization consumes that list.
  media.sort((a, b) => Number(b.id === primary?.mediaId) - Number(a.id === primary?.mediaId));
  for (const item of media) {
    if (primary) item.logoCandidate = item.id === primary.mediaId;
  }
  return primary ?? null;
}

/**
 * Reads one media part: its entry, its logo candidacy and (for slide photos and pictures the
 * template shows desaturated) its grey copy.
 * @param {{greys: Parameters<typeof addGrey>[0], media: MediaEntry[], logos: Logo[],
 *   decode: SharpCtor|null, layouts: Map<string,LayoutUse>}} into
 * @param {{part: string, bytes: Uint8Array, use: MediaUse|undefined}} entry
 */
async function readOneMedia(into, { part, bytes, use }) {
  const id = part.slice("ppt/media/".length);
  const roles = use ? [...use.roles] : [];
  const { width, height, format } = await probeMedia(into.decode, bytes, (id.split(".").pop() ?? "").toLowerCase());
  const candidate = logoLike(roles, use);
  const raster = Boolean(width && height && ["png", "jpeg", "gif", "webp"].includes(format));
  const decoded = candidate && raster ? await imageFullyDecodes(bytes) : false;
  const placements = clampedPlacements(use);
  into.media.push({
    id,
    part,
    bytes: bytes.length,
    format,
    width,
    height,
    roles,
    logoCandidate: candidate,
    ...(candidate && decoded ? { sha256: hash(bytes), placements } : {}),
    ...(candidate && raster && !decoded ? { logoUndecodable: true } : {}),
  });
  if (candidate) into.logos.push(logoOf({ id, width, height, placements, decoded, bytes }, into.layouts, use));
  // Slide photos are always offered in grey. Layout, master and logo pictures only when the
  // template itself shows them desaturated; the kit has no other source for that grey.
  const slidePhoto = !candidate && raster && roles.some((r) => r === "slide");
  if (into.decode && raster && (slidePhoto || use?.grayscale)) {
    await addGrey(into.greys, { id, part, bytes, slidePhoto });
  }
}

/** Reads original bytes only from the guarded package; never dereferences external links.
 * Without the optional image decoder the media keep their parts and sizes, no logo or grey
 * copy is derived, and a `decoder-unavailable` warning says so.
 * @param {import("./ooxml.mjs").PackageReader} pkg @param {Map<string,MediaUse>} uses
 * @param {Map<string,LayoutUse>} layouts
 * @param {{chromeGreyMaxBytes?: number, slideGreyMaxBytes?: number}} [options] */
export async function readTemplateMedia(pkg, uses, layouts, options = {}) {
  const decode = await loadSharp();
  /** @type {MediaEntry[]} */ const media = [];
  /** @type {Logo[]} */ const logos = [];
  /** @type {Photo[]} */ const photos = [];
  /** @type {Photo[]} */ const chromePhotos = [];
  /** @type {Asset[]} */ const assets = [];
  /** @type {{code:string,message:string}[]} */ const warnings = [];
  const greys = {
    decode: /** @type {SharpCtor} */ (decode),
    photos,
    chromePhotos,
    assets,
    warnings,
    ...greyBudgets(options, pkg.bytes.length),
    names: new Set(),
  };
  const into = { greys, media, logos, decode, layouts };
  for (const entry of pkg.entries) {
    if (!entry.name.startsWith("ppt/media/") || entry.name.endsWith("/")) continue;
    const bytes = pkg.read(entry.name);
    if (!bytes) continue;
    if (entry.name.toLowerCase().endsWith(".wdp")) {
      ensureWdpWarning(warnings);
      continue;
    }
    await readOneMedia(into, { part: entry.name, bytes, use: uses.get(entry.name) });
  }
  if (!decode && media.length) {
    warnings.push({
      code: DECODER_UNAVAILABLE,
      message: "本机未安装可选的图片解码组件，模板图片的尺寸、Logo 与去色副本未提取；文字与版式仍可使用",
    });
  }
  const logo = selectPrimary(logos, media);
  return { media, logos, logo, photos, chromePhotos, assets, warnings };
}

/** @param {string[]} roles @param {MediaUse|undefined} use */
function logoLike(roles, use) {
  return (
    roles.some((role) => role === "master" || role === "layout") &&
    Boolean(use?.boxes.some((box) => box.w > 0 && box.h > 0 && box.w < 0.35 && box.h < 0.25)) &&
    !roles.some((role) => role.endsWith("-background"))
  );
}
