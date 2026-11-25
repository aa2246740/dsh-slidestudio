import { describe, it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { patchCoreTimestamps, pinPackageTimestamps, pinZipEntryDates } from "./export-timestamps.js";

const CORE = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="c" xmlns:dcterms="d"><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-24T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-24T10:00:00Z</dcterms:modified></cp:coreProperties>`;

/** A small package whose entries were written at `time`, as a writer's wall clock would. */
function packageWrittenAt(time: Date): JSZip {
  const zip = new JSZip();
  zip.file("docProps/core.xml", CORE, { date: time });
  zip.file("ppt/slides/slide1.xml", "<p:sld/>", { date: time });
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71]), { date: time });
  return zip;
}

/** A chart workbook as pptxgenjs builds it: a zip of its own, stamped with the wall clock. */
async function workbookWrittenAt(time: Date): Promise<Uint8Array> {
  const book = new JSZip();
  const created = time.toISOString().replace(/\.\d{3}Z$/, "Z");
  book.file("docProps/core.xml", CORE.replaceAll("2026-09-24T10:00:00Z", created), { date: time });
  book.file("xl/workbook.xml", "<workbook/>", { date: time });
  return book.generateAsync({ type: "uint8array" });
}

/** A package whose embedded chart workbook was written at `time`, as pptxgenjs embeds it. */
async function packageWithWorkbookAt(time: Date): Promise<JSZip> {
  const zip = packageWrittenAt(time);
  zip.file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx", await workbookWrittenAt(time), {
    date: time,
  });
  return zip;
}

describe("export timestamps", () => {
  it("packages written in different seconds are byte-identical once their entry dates are pinned", async () => {
    const early = packageWrittenAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 0)));
    const late = packageWrittenAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 6)));

    const unpinnedEarly = await early.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const unpinnedLate = await late.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    assert.notDeepEqual(unpinnedEarly, unpinnedLate, "the wall clock leaks into entry dates");

    pinZipEntryDates(early);
    pinZipEntryDates(late);
    const pinnedEarly = await early.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const pinnedLate = await late.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    assert.deepEqual(pinnedEarly, pinnedLate);
  });

  it("pinPackageTimestamps rewinds docProps dates and stamps every entry with the pinned instant", async () => {
    const zip = packageWrittenAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 0)));
    await pinPackageTimestamps(zip);
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

    const core = await loaded.file("docProps/core.xml")!.async("string");
    assert.equal(core.match(/<dcterms:(created|modified)[^>]*>([^<]*)</g)?.length, 2, "both core dates are present");
    assert.doesNotMatch(core, /2026-09-24/);
    assert.match(core, /<dcterms:created[^>]*>2000-01-01T00:00:00Z</);
    for (const [name, entry] of Object.entries(loaded.files)) {
      assert.equal(entry.date.getTime(), Date.UTC(2000, 0, 1), `${name} keeps the pinned date`);
    }
  });

  it("packages with chart workbooks written in different seconds are byte-identical once pinned", async () => {
    const early = await packageWithWorkbookAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 0)));
    const late = await packageWithWorkbookAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 6)));
    await pinPackageTimestamps(early);
    await pinPackageTimestamps(late);
    assert.deepEqual(
      await early.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      await late.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
  });

  it("pinPackageTimestamps pins the dates inside each embedded chart workbook", async () => {
    const zip = await packageWithWorkbookAt(new Date(Date.UTC(2026, 8, 24, 10, 0, 0)));
    await pinPackageTimestamps(zip);
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const workbook = await JSZip.loadAsync(
      await loaded.file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")!.async("uint8array"),
    );

    const core = await workbook.file("docProps/core.xml")!.async("string");
    assert.doesNotMatch(core, /2026-09-24/, "the workbook's own core dates are pinned");
    assert.match(core, /<dcterms:created[^>]*>2000-01-01T00:00:00Z</);
    for (const [name, entry] of Object.entries(workbook.files)) {
      assert.equal(entry.date.getTime(), Date.UTC(2000, 0, 1), `workbook ${name} keeps the pinned date`);
    }
  });

  it("patchCoreTimestamps leaves other properties untouched", () => {
    const patched = patchCoreTimestamps(
      CORE.replace("</cp:coreProperties>", "<cp:revision>3</cp:revision></cp:coreProperties>"),
    );
    assert.match(patched, /<cp:revision>3<\/cp:revision>/);
    assert.equal((patched.match(/2000-01-01T00:00:00Z/g) ?? []).length, 2);
  });
});
