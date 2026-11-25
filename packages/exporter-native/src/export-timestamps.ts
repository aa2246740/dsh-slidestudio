// Reproducible package timestamps: docProps dates, every zip entry date and the chart
// workbooks pptxgenjs embeds carry one pinned instant, so the wall clock never changes the
// bytes. Chart part numbers still come from pptxgenjs's process-wide counter.

import JSZip from "jszip";

/** 2000-01-01T00:00:00Z: the instant every exported timestamp carries. */
const PINNED_INSTANT = Date.UTC(2000, 0, 1);

/** Rewind docProps created/modified timestamps to the pinned instant. */
export function patchCoreTimestamps(xml: string): string {
  const epoch = "2000-01-01T00:00:00Z";
  return xml.replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, `$1${epoch}$2`);
}

/**
 * Stamp every entry with the pinned date. JSZip writes DOS fields from UTC getters,
 * so the bytes match across time zones too. Without this, an entry that a rewrite
 * re-adds (or an untouched entry from the first writer) keeps its wall-clock time.
 */
export function pinZipEntryDates(zip: JSZip): void {
  for (const entry of Object.values(zip.files)) {
    entry.date = new Date(PINNED_INSTANT);
  }
}

/**
 * pptxgenjs builds each chart workbook as a zip of its own, stamped with the wall clock in
 * its entry dates and dcterms:created / dcterms:modified. Rewrite each embedded workbook with
 * the pinned instant. This runs before the outer stamp, because re-adding an entry resets it.
 */
async function pinEmbeddedWorkbooks(zip: JSZip): Promise<void> {
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/embeddings\/[^/]+\.xlsx$/.test(name)) continue;
    const embedded = zip.file(name);
    if (!embedded) continue;
    const workbook = await JSZip.loadAsync(await embedded.async("uint8array"));
    const core = workbook.file("docProps/core.xml");
    if (core) workbook.file("docProps/core.xml", patchCoreTimestamps(await core.async("string")));
    pinZipEntryDates(workbook);
    zip.file(name, await workbook.generateAsync({ type: "uint8array" }));
  }
}

/** Pin docProps, every embedded chart workbook and every entry of a package about to be generated. */
export async function pinPackageTimestamps(zip: JSZip): Promise<void> {
  const core = zip.file("docProps/core.xml");
  if (core) zip.file("docProps/core.xml", patchCoreTimestamps(await core.async("string")));
  await pinEmbeddedWorkbooks(zip);
  pinZipEntryDates(zip);
}
