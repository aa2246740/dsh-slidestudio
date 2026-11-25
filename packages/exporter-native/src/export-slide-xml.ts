/**
 * XML post-passes for slide and chart parts. Every slide part goes through
 * `patchSlideXml`, whether or not the slide has other patches, so a picture can
 * never leave the export with a local path in its alt text.
 */

/**
 * pptxgenjs takes one fontFace, so a pair travels as `latin***ea`. It then
 * writes that string onto `<a:latin>`, and sometimes onto `<a:ea>` / `<a:cs>`
 * as well, with extra attributes such as pitchFamily. Rewrite each tag in
 * place: latin and cs keep the Latin face, ea keeps the East Asian face.
 * When a rewritten latin tag has no ea sibling yet, insert one. A face
 * without the marker is left untouched.
 */
function splitFontMarkers(xml: string): string {
  const withLatin = xml.replace(
    /<a:latin\b([^>]*?)typeface="([^"]*)\*\*\*([^"]*)"([^>]*?)\/>/g,
    (full, before: string, latin: string, ea: string, after: string, offset: number, source: string) => {
      const rest = source.slice(offset + full.length, offset + full.length + 500);
      const end = rest.search(/<\/a:(?:defRPr|rPr|endParaRPr)>/);
      const scope = end >= 0 ? rest.slice(0, end) : rest;
      let extra = "";
      if (!/<a:ea\b/.test(scope)) extra += `<a:ea typeface="${ea || latin}"/>`;
      if (!/<a:cs\b/.test(scope)) extra += `<a:cs typeface="${latin}"/>`;
      return `<a:latin${before}typeface="${latin}"${after}/>${extra}`;
    },
  );
  return withLatin.replace(
    /<a:(ea|cs)\b([^>]*?)typeface="([^"]*)\*\*\*([^"]*)"([^>]*?)\/>/g,
    (_full, tag: string, before: string, latin: string, ea: string, after: string) =>
      `<a:${tag}${before}typeface="${tag === "ea" ? ea || latin : latin}"${after}/>`,
  );
}

export function patchChartFonts(xml: string): string {
  return splitFontMarkers(xml);
}

/**
 * pptxgenjs writes `descr="<altText or image path>"` on every picture, and falls
 * back to the path the picture was read from. PPTD v2 has no alt-text field, so
 * the exporter would publish the absolute path of each picture. The attribute is
 * dropped instead: PowerPoint reads a picture without descr as missing alt text,
 * the same as an empty one. Each picture still resolves through its r:embed
 * relationship to ppt/media/*.
 */
function dropPictureDescr(xml: string): string {
  return xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (pic) => pic.replace(/(<p:cNvPr\b[^>]*?)\sdescr="[^"]*"/, "$1"));
}

/** One slide part, patched or not: font markers split, picture descr dropped. */
export function patchSlideXml(xml: string): string {
  return dropPictureDescr(splitFontMarkers(xml));
}
