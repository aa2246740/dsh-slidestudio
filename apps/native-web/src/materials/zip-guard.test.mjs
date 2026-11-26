import assert from "node:assert/strict";
import { deflateSync, zipSync, strToU8 } from "fflate";
import { test } from "node:test";
import { MaterialRejection, readCentralDirectory, readZipEntry, assertZipLimits } from "./zip-guard.mjs";

/**
 * Hand-write a zip whose central directory declares arbitrary sizes.
 * @param {{name: string, declaredUncompressed: number, declaredCompressed: number, payload: Uint8Array, method?: number}} spec
 */
function lyingZip({ name, declaredUncompressed, declaredCompressed, payload, method = 8 }) {
  const nameBytes = Buffer.from(name, "utf8");
  const crc = 0;
  const local = Buffer.alloc(30 + nameBytes.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(declaredCompressed, 18);
  local.writeUInt32LE(declaredUncompressed, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  local.set(payload, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(declaredCompressed, 20);
  central.writeUInt32LE(declaredUncompressed, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test("central directory is read without inflating and normal archives pass", () => {
  const archive = zipSync({ "a.txt": strToU8("hello"), "dir/b.txt": strToU8("world") });
  const entries = readCentralDirectory(archive);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["a.txt", "dir/b.txt"],
  );
});

test("more than 5000 entries is rejected before any inflation", () => {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  for (let i = 0; i < 5001; i += 1) files[`p/${i}.bin`] = new Uint8Array(0);
  const archive = zipSync(files);
  const start = process.memoryUsage().heapUsed;
  assert.throws(
    () => readCentralDirectory(archive),
    (/** @type {MaterialRejection} */ error) => {
      assert.equal(error.code, "archive-limit");
      return true;
    },
  );
  assert.ok(process.memoryUsage().heapUsed - start < 50 * 1024 * 1024);
});

test("an entry declaring ≥1 GB with a tiny compressed payload is rejected", () => {
  const archive = lyingZip({
    name: "xl/worksheets/sheet1.xml",
    declaredUncompressed: 1024 * 1024 * 1024,
    declaredCompressed: 1024,
    payload: deflateSync(Buffer.alloc(1024)),
  });
  assert.throws(
    () => readCentralDirectory(archive),
    (/** @type {MaterialRejection} */ error) => {
      assert.equal(error.code, "archive-limit");
      return true;
    },
  );
});

test("declared total above 200 MB is rejected from header metadata alone", () => {
  const archive = lyingZip({
    name: "part.xml",
    declaredUncompressed: 201 * 1024 * 1024,
    declaredCompressed: 2 * 1024 * 1024, // ratio 100 — total is what trips
    payload: deflateSync(Buffer.alloc(2048)),
  });
  assert.throws(
    () => readCentralDirectory(archive),
    (/** @type {MaterialRejection} */ error) => {
      assert.equal(error.code, "archive-limit");
      return true;
    },
  );
});

test("a truncated zip (cut in half) is corrupt, not a crash", () => {
  const archive = zipSync({ "a.txt": strToU8("hello world") });
  const cut = archive.subarray(0, Math.floor(archive.length / 2));
  assert.throws(() => readCentralDirectory(cut), MaterialRejection);
});

test("inflated length is re-checked against the declared size", () => {
  const payload = deflateSync(Buffer.from("actual bytes"));
  const archive = lyingZip({
    name: "a.xml",
    declaredUncompressed: 999,
    declaredCompressed: payload.length,
    payload,
  });
  const entries = readCentralDirectory(archive);
  assert.throws(() => readZipEntry(archive, entries[0]), /损坏|incomplete|不完整/);
});

test("an entry under-declaring its size fails archive-limit before expanding", () => {
  // Central directory claims 32 bytes; the deflate payload expands to 8 MiB.
  // The inflater must stop at the cap instead of materializing the payload:
  // fflate's Inflate.push runs inflt() to completion before ondata, so the
  // regression is measured on arrayBuffers/external/RSS, which count the
  // Uint8Array backing stores heapUsed misses.
  const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const payload = deflateSync(big);
  const archive = lyingZip({
    name: "[Content_Types].xml",
    declaredUncompressed: 32,
    declaredCompressed: payload.length,
    payload,
  });
  const entries = readCentralDirectory(archive);
  const before = process.memoryUsage();
  assert.throws(
    () => readZipEntry(archive, entries[0]),
    (/** @type {MaterialRejection} */ error) => {
      assert.equal(error.code, "archive-limit");
      return true;
    },
  );
  const after = process.memoryUsage();
  const budget = 4 * 1024 * 1024;
  // Growth must stay far below the 8 MiB lie (old fflate path grew
  // arrayBuffers by ~42 MB and RSS by ~36 MB on this shape).
  assert.ok(
    after.arrayBuffers - before.arrayBuffers < budget,
    `arrayBuffers grew by ${after.arrayBuffers - before.arrayBuffers} bytes`,
  );
  assert.ok(after.external - before.external < budget, `external grew by ${after.external - before.external} bytes`);
  assert.ok(after.rss - before.rss < budget, `rss grew by ${after.rss - before.rss} bytes`);
});

test("stored entries still re-check their declared length", () => {
  const archive = lyingZip({
    name: "raw.txt",
    declaredUncompressed: 999,
    declaredCompressed: 5,
    payload: Buffer.from("hello"),
    method: 0,
  });
  const entries = readCentralDirectory(archive);
  assert.throws(() => readZipEntry(archive, entries[0]), MaterialRejection);
});

test("real entry bytes round-trip through the guard", () => {
  const archive = zipSync({ "a.txt": strToU8("hello world") });
  const entries = readCentralDirectory(archive);
  const bytes = readZipEntry(archive, entries[0]);
  assert.equal(new TextDecoder().decode(bytes), "hello world");
  assert.equal(assertZipLimits(entries), undefined);
});
