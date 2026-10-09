// Real font embedding for exported PPTX: subset vendored woff2 faces to the
// deck's charset, then wire OOXML embeddedFontLst parts into the zip.
import fs from "node:fs";
import path from "node:path";
import { Font, woff2 } from "fonteditor-core";
import { resolveTextStyle, } from "@open-slidestudio/pptd-v2";
let woff2Ready;
function ensureWoff2() {
    if (!woff2Ready)
        woff2Ready = woff2.init();
    return woff2Ready;
}
function walkStrings(value, visit) {
    if (typeof value === "string") {
        if (value)
            visit(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            walkStrings(item, visit);
        return;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value))
            walkStrings(item, visit);
    }
}
function addFamilyParts(families, value) {
    if (typeof value === "string") {
        if (value.trim())
            families.add(value.trim());
        return;
    }
    if (value && typeof value === "object") {
        if (value.ea?.trim())
            families.add(value.ea.trim());
        if (value.latin?.trim())
            families.add(value.latin.trim());
    }
}
/**
 * Collect the deck's font families and a charset covering every renderable
 * string. The charset is a union over all text, so each embedded face gets a
 * conservative superset of the glyphs it can be asked to draw.
 */
export function collectUsedText(project) {
    const families = new Set();
    const charset = new Set();
    for (let cp = 0x20; cp <= 0x7e; cp += 1)
        charset.add(cp);
    const theme = project.presentation.theme;
    for (const style of Object.values(theme?.textStyles ?? {})) {
        addFamilyParts(families, style?.fontFamily);
    }
    for (const custom of project.presentation.customFonts ?? []) {
        addFamilyParts(families, custom?.family);
    }
    const remember = (text) => {
        for (const ch of text)
            charset.add(ch.codePointAt(0));
    };
    if (project.presentation.title)
        remember(project.presentation.title);
    for (const loaded of project.pages) {
        const page = loaded.page;
        if (page.notes)
            remember(page.notes);
        for (const el of page.elements) {
            if (el.elementType === "text") {
                const content = el.content;
                addFamilyParts(families, content?.fontFamily);
                const resolved = resolveTextStyle(content ?? { text: "" }, theme);
                addFamilyParts(families, resolved.fontFamily);
            }
            walkStrings(el, remember);
        }
    }
    return { families, charset };
}
/** OS/2 fsType bit 0x0002 = Restricted License: embedding is not permitted. */
export function fsTypeRestricted(fsType) {
    return ((fsType ?? 0) & 0x0002) !== 0;
}
/** Read fsType straight from the sfnt directory, before any subset work. */
export function sfntFsType(sfnt) {
    const buf = Buffer.isBuffer(sfnt) ? sfnt : Buffer.from(sfnt);
    if (buf.byteLength < 12)
        return undefined;
    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i += 1) {
        const off = 12 + i * 16;
        if (off + 16 > buf.byteLength)
            return undefined;
        if (buf.toString("ascii", off, off + 4) === "OS/2") {
            const tableOff = buf.readUInt32BE(off + 8);
            return tableOff + 10 <= buf.byteLength
                ? buf.readUInt16BE(tableOff + 8)
                : undefined;
        }
    }
    return undefined;
}
function decodeToSfnt(bytes) {
    // woff2 signature 'wOF2'; plain woff ('wOFF') is left for Font to reject.
    if (bytes.byteLength >= 4 && bytes.toString("ascii", 0, 4) === "wOF2") {
        return Buffer.from(woff2.decode(bytes));
    }
    return bytes;
}
/** fonteditor only converts CFF1 outlines; CFF2 (variable OTTO) cannot embed. */
function sfntHasCff2(sfnt) {
    if (sfnt.byteLength < 12)
        return false;
    const numTables = sfnt.readUInt16BE(4);
    for (let i = 0; i < numTables; i += 1) {
        const off = 12 + i * 16;
        if (off + 16 > sfnt.byteLength)
            return false;
        if (sfnt.toString("ascii", off, off + 4) === "CFF2")
            return true;
    }
    return false;
}
function escapeXmlAttr(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
/**
 * PowerPoint binds embedded fonts by name-table identity. When the internal
 * family differs from the CSS family we rename IDs 1/3/4/6/16 so the typeface
 * attribute resolves. postScriptName stays ASCII per the PostScript spec.
 * `subFamily` is "Regular" or "Bold": IDs 2/17 carry it, ID 4 becomes
 * `${family} Bold`, and ID 6 gets the matching -Regular/-Bold suffix.
 */
function rewriteNameTable(name, family, index, subFamily = "Regular") {
    if (name.fontFamily === family &&
        name.preferredFamily === family &&
        name.fontSubFamily === subFamily) {
        return;
    }
    const ascii = family.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
        `EmbeddedFont${index}`;
    name.fontFamily = family;
    name.preferredFamily = family;
    name.preferredSubFamily = subFamily;
    name.fontSubFamily = subFamily;
    name.fullName = subFamily === "Regular" ? family : `${family} ${subFamily}`;
    name.postScriptName = `${ascii}-${subFamily}`;
    const version = (name.version ?? "1.0").replace(/^version\s*/i, "");
    name.uniqueSubFamily = `${version};${family};${subFamily}`;
}
/**
 * Pick the entry whose weight is closest to `target` among those accepted by
 * `accept`. Ties keep css order (first match wins).
 */
function closestWeight(entries, target, accept) {
    let best;
    for (const entry of entries) {
        if (!accept(entry.weight))
            continue;
        if (!best ||
            Math.abs(entry.weight - target) < Math.abs(best.weight - target)) {
            best = entry;
        }
    }
    return best;
}
/**
 * Subset every used family that ships in fonts.css into real TTF payloads.
 * A family yields up to two faces: the regular slot (weight closest to 400
 * among ≤500, else the first entry) and the bold slot (closest to 700 among
 * >500, when a distinct face exists). Per-font failures never abort the
 * export — the family lands in `skipped`.
 */
export async function buildEmbeddedFonts(project, families, fontsDir) {
    await ensureWoff2();
    const used = collectUsedText(project);
    const codepoints = [...used.charset].sort((a, b) => a - b);
    const plan = { fonts: [], skipped: [] };
    const sorted = [...used.families].sort((a, b) => a.localeCompare(b));
    for (const [index, family] of sorted.entries()) {
        const entries = families.get(family);
        if (!entries?.length) {
            plan.skipped.push({ typeface: family, reason: "not in fonts.css" });
            continue;
        }
        const regularEntry = closestWeight(entries, 400, (w) => w <= 500) ?? entries[0];
        const boldEntry = closestWeight(entries, 700, (w) => w > 500);
        const picks = [{ entry: regularEntry, subFamily: "Regular", weight: 400 }];
        if (boldEntry && boldEntry !== regularEntry) {
            picks.push({ entry: boldEntry, subFamily: "Bold", weight: 700 });
        }
        for (const pick of picks) {
            try {
                const file = path.isAbsolute(pick.entry.file)
                    ? pick.entry.file
                    : path.join(fontsDir, pick.entry.file);
                const sfnt = decodeToSfnt(fs.readFileSync(file));
                const fsType = sfntFsType(sfnt);
                if (fsTypeRestricted(fsType)) {
                    plan.skipped.push({ typeface: family, reason: "license (fsType Restricted)" });
                    continue;
                }
                if (sfntHasCff2(sfnt)) {
                    plan.skipped.push({ typeface: family, reason: "unsupported CFF2 outlines" });
                    continue;
                }
                const magic = sfnt.toString("ascii", 0, 4);
                const font = Font.create(sfnt, {
                    type: magic === "OTTO" ? "otf" : "ttf",
                    subset: codepoints,
                });
                const data = font.get();
                rewriteNameTable(data.name, family, index, pick.subFamily);
                const ttf = Buffer.from(font.write({ type: "ttf", toBuffer: true }));
                plan.fonts.push({
                    typeface: family,
                    weight: pick.weight,
                    ttf,
                    glyphs: Array.isArray(data.glyf) ? data.glyf.length : 0,
                });
            }
            catch (error) {
                plan.skipped.push({
                    typeface: family,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return plan;
}
/**
 * Inject fntdata parts, rels, and p:embeddedFontLst into a pptx zip.
 * embeddedFontLst must sit before p:defaultTextStyle in p:presentation.
 */
export async function embedFontsIntoPptx(buffer, plan) {
    if (!plan.fonts.length)
        return { data: buffer, embedded: [] };
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buffer);
    plan.fonts.forEach((font, index) => {
        zip.file(`ppt/fonts/font${index + 1}.fntdata`, font.ttf);
    });
    const ctFile = zip.file("[Content_Types].xml");
    if (!ctFile)
        throw new Error("native exporter: [Content_Types].xml missing");
    let contentTypes = await ctFile.async("string");
    if (!/Extension="fntdata"/.test(contentTypes)) {
        contentTypes = contentTypes.replace("</Types>", '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>');
        zip.file("[Content_Types].xml", contentTypes);
    }
    const relsPath = "ppt/_rels/presentation.xml.rels";
    const relsFile = zip.file(relsPath);
    if (!relsFile)
        throw new Error(`native exporter: ${relsPath} missing`);
    const rels = await relsFile.async("string");
    let maxRid = 0;
    for (const m of rels.matchAll(/Id="rId(\d+)"/g)) {
        maxRid = Math.max(maxRid, Number(m[1]));
    }
    const relEntries = plan.fonts
        .map((font, index) => `<Relationship Id="rId${maxRid + index + 1}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" ` +
        `Target="fonts/font${index + 1}.fntdata"/>`)
        .join("");
    zip.file(relsPath, rels.replace("</Relationships>", `${relEntries}</Relationships>`));
    const presFile = zip.file("ppt/presentation.xml");
    if (!presFile)
        throw new Error("native exporter: ppt/presentation.xml missing");
    let pres = await presFile.async("string");
    if (!/embedTrueTypeFonts=/.test(pres)) {
        pres = pres.replace(/<p:presentation\b/, '<p:presentation embedTrueTypeFonts="1"');
    }
    if (!/saveSubsetFonts=/.test(pres)) {
        pres = pres.replace(/<p:presentation\b/, '<p:presentation saveSubsetFonts="1"');
    }
    if (!pres.includes("<p:embeddedFontLst")) {
        // One p:embeddedFont per family; each embedded face fills its weight slot
        // (≤500 regular, >500 bold) with its own rId/fntdata part.
        const slotsByFamily = new Map();
        plan.fonts.forEach((font, index) => {
            const rid = maxRid + index + 1;
            let slots = slotsByFamily.get(font.typeface);
            if (!slots) {
                slots = {};
                slotsByFamily.set(font.typeface, slots);
            }
            if (font.weight > 500) {
                if (slots.bold === undefined)
                    slots.bold = rid;
            }
            else if (slots.regular === undefined) {
                slots.regular = rid;
            }
        });
        const fontLst = `<p:embeddedFontLst>${[...slotsByFamily]
            .map(([typeface, slots]) => {
            const regular = slots.regular ?? slots.bold;
            return (`<p:embeddedFont><p:font typeface="${escapeXmlAttr(typeface)}"/>` +
                (regular !== undefined ? `<p:regular r:id="rId${regular}"/>` : "") +
                (slots.bold !== undefined ? `<p:bold r:id="rId${slots.bold}"/>` : "") +
                `</p:embeddedFont>`);
        })
            .join("")}</p:embeddedFontLst>`;
        if (pres.includes("<p:defaultTextStyle")) {
            pres = pres.replace("<p:defaultTextStyle", `${fontLst}<p:defaultTextStyle`);
        }
        else {
            pres = pres.replace("</p:presentation>", `${fontLst}</p:presentation>`);
        }
    }
    zip.file("ppt/presentation.xml", pres);
    for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir)
            delete zip.files[name];
    }
    const data = (await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    }));
    return {
        data,
        embedded: plan.fonts.map((font) => ({
            typeface: font.typeface,
            weight: font.weight,
            bytes: font.ttf.byteLength,
            glyphs: font.glyphs,
        })),
    };
}
//# sourceMappingURL=font-embed.js.map