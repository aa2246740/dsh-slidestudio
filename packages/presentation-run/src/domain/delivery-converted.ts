/**
 * The legacy conversion origin of a delivery-provenance material (CAP-37,
 * M8), read from the material's own hash-verified conversion receipt. WPS
 * origins keep the vendor name so the 「资料使用情况」 card can say
 * 「（由 WPS .dps 转换）」; plain uploads carry no origin.
 */

export type ConvertedOrigin = Readonly<{
  /** The legacy extension a conversion came from, e.g. ".ppt"; absent otherwise. */
  convertedFrom: string;
  /** True for a WPS origin (.wps/.et/.dps); the card names WPS. */
  convertedFromWps?: true;
}>;

/** Origin extensions that name a WPS format. */
const WPS_LEGACY_EXTENSIONS: ReadonlySet<string> = new Set([".wps", ".et", ".dps"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function convertedOriginOf(derivative: Record<string, unknown> | undefined): ConvertedOrigin | undefined {
  const conversion = derivative?.conversion;
  if (!isRecord(conversion)) return undefined;
  const from = conversion.from;
  if (typeof from !== "string" || !/^\.[A-Za-z0-9]{1,9}$/.test(from)) return undefined;
  return {
    convertedFrom: from,
    ...(WPS_LEGACY_EXTENSIONS.has(from) ? { convertedFromWps: true as const } : {}),
  };
}
