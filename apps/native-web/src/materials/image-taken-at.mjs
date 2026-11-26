/** Read only the EXIF sub-IFD DateTimeOriginal tag; never traverse location IFDs.
 * Keep its local wall-clock string: EXIF does not imply a timezone.
 * @param {Buffer|undefined} exif @returns {string|undefined} */
export function dateTimeOriginal(exif) {
  if (!exif) return undefined;
  try {
    const bytes = exif.subarray(exif.subarray(0, 6).toString("ascii") === "Exif\0\0" ? 6 : 0);
    const order = bytes.subarray(0, 2).toString("ascii");
    if (order !== "II" && order !== "MM") return undefined;
    const little = order === "II";
    /** @param {number} offset */
    const u16 = (offset) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
    /** @param {number} offset */
    const u32 = (offset) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
    if (u16(2) !== 42) return undefined;
    /** @param {number} offset @param {number} tag */
    const entry = (offset, tag) => {
      const count = u16(offset);
      if (count > 256 || offset + 2 + count * 12 + 4 > bytes.length) return undefined;
      for (let i = 0; i < count; i += 1) {
        const at = offset + 2 + i * 12;
        if (u16(at) === tag) return at;
      }
      return undefined;
    };
    const pointer = entry(u32(4), 0x8769);
    if (pointer === undefined || u16(pointer + 2) !== 4 || u32(pointer + 4) !== 1) return undefined;
    const date = entry(u32(pointer + 8), 0x9003);
    if (date === undefined || u16(date + 2) !== 2 || u32(date + 4) !== 20) return undefined;
    const offset = u32(date + 8);
    if (offset + 20 > bytes.length || bytes[offset + 19] !== 0) return undefined;
    const value = bytes.subarray(offset, offset + 19).toString("ascii");
    if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
    const iso = `${value.slice(0, 10).replaceAll(":", "-")}T${value.slice(11)}.000Z`;
    const parsed = new Date(iso);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso ? value : undefined;
  } catch {
    return undefined;
  }
}
