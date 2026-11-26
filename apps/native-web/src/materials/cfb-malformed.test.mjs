import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { container, excelItems, pptItems, seededBytes, wordItems } from "./test-fixtures/legacy-office-fixtures.mjs";
import { classifyLegacyOffice } from "./cfb.mjs";
import {
  timed,
  extensionOf,
  fixture,
  shape,
  build,
  setFat,
  streamSectors,
  entryOffset,
  filler,
  REJECTED,
} from "./test-fixtures/cfb-test-kit.mjs";

/** @typedef {import("./cfb.mjs").LegacyClassification} LegacyClassification */
/** @typedef {{path: string, data: Uint8Array}} StreamItem a stream item, which always has data */

describe("malformed containers are rejected without a throw or a hang", () => {
  const plain = build(wordItems({ size: 8192 }));
  const small = build(wordItems());
  const ppt = build(pptItems({ size: 16384 }));
  const copy = (/** @type {Uint8Array} */ bytes) => Buffer.from(bytes);
  /** A copy of the plain file with one header field rewritten. */
  const withHeader = (/** @type {(bytes: Buffer) => unknown} */ write) => () => {
    const bytes = copy(plain.bytes);
    write(bytes);
    return bytes;
  };
  const wordStream = streamSectors(plain.layout, "WordDocument");
  const [firstDirectorySector] = plain.layout.directorySectors;
  /** A copy of the plain file with one FAT entry rewritten. */
  const withFat = (/** @type {number} */ id, /** @type {number} */ value) => () => {
    const bytes = copy(plain.bytes);
    setFat(bytes, plain.layout, id, value);
    return bytes;
  };
  const currentUserCase = (/** @type {(currentUser: Buffer, document: Uint8Array) => unknown} */ change) => () => {
    const items = pptItems({ size: 1024 });
    const document = /** @type {StreamItem} */ (items.find((item) => item.path === "PowerPoint Document")).data;
    const currentUser = Buffer.from(
      /** @type {StreamItem} */ (items.find((item) => item.path === "Current User")).data,
    );
    change(currentUser, document);
    return build([
      { path: "PowerPoint Document", data: document },
      { path: "Current User", data: currentUser },
    ]).bytes;
  };

  /** @type {Record<string, {bytes: () => Uint8Array, reason: string, extension?: string}>} */
  const cases = {
    "an empty file": { bytes: () => Buffer.alloc(0), reason: "not-cfb" },
    "a file shorter than the header": {
      bytes: () => plain.bytes.subarray(0, 300),
      reason: "not-cfb",
    },
    "a wrong signature": { bytes: withHeader((bytes) => (bytes[0] = 0x50)), reason: "not-cfb" },
    "an unsupported sector shift": {
      bytes: withHeader((bytes) => bytes.writeUInt16LE(10, 30)),
      reason: "bad-header",
    },
    "a mini sector shift other than 6": {
      bytes: withHeader((bytes) => bytes.writeUInt16LE(7, 32)),
      reason: "bad-header",
    },
    "a mini stream cutoff other than 4096": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(64, 56)),
      reason: "bad-header",
    },
    "a wrong byte order mark": {
      bytes: withHeader((bytes) => bytes.writeUInt16LE(0xfeff, 28)),
      reason: "bad-header",
    },
    "only the header": { bytes: () => plain.bytes.subarray(0, 512), reason: "bad-fat" },
    "cut in the middle of the file (the Word stream is now larger than the file)": {
      bytes: () => plain.bytes.subarray(0, Math.floor(plain.bytes.length / 2)),
      reason: "bad-stream",
    },
    "the last sector of the Word stream cut away": {
      bytes: () => plain.bytes.subarray(0, plain.bytes.length - 512),
      reason: "bad-sector",
    },
    "the last sector of the Word stream cut in half": {
      bytes: () => plain.bytes.subarray(0, plain.bytes.length - 256),
      reason: "truncated",
    },
    "a FAT chain loop inside the Word stream": {
      bytes: withFat(/** @type {number} */ (wordStream.at(-1)), wordStream[0]),
      reason: "bad-chain",
    },
    "a FAT chain loop in the directory": {
      bytes: withFat(firstDirectorySector, firstDirectorySector),
      reason: "bad-chain",
    },
    "a MiniFAT chain loop inside a small stream": {
      bytes: () => {
        const bytes = copy(small.bytes);
        const { start } = small.layout.streams.WordDocument;
        const sector = small.layout.miniFatSectors[0];
        bytes.writeUInt32LE(start, (sector + 1) * 512 + (start + 1) * 4);
        return bytes;
      },
      reason: "bad-chain",
    },
    "a DIFAT chain that points back at itself": {
      bytes: () => {
        const large = build(wordItems({ size: 8 * 1024 * 1024 }));
        const bytes = copy(large.bytes);
        const sector = large.layout.difatSectors[0];
        bytes.writeUInt32LE(sector, (sector + 1) * 512 + 127 * 4);
        return bytes;
      },
      reason: "bad-chain",
    },
    "4097 directory entries": {
      bytes: () => build([...wordItems(), ...filler(4093)]).bytes,
      reason: "too-many-entries",
    },
    "a FAT chain that runs to a sector id beyond the file": {
      bytes: withFat(wordStream[1], 0x7fffffff),
      reason: "bad-sector",
    },
    "a FAT chain that runs into a free sector": {
      bytes: withFat(wordStream[1], 0xffffffff),
      reason: "bad-sector",
    },
    "a stream whose start sector is beyond the file": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(0x00ffffff, entryOffset(plain.layout, "WordDocument") + 116)),
      reason: "bad-sector",
    },
    "a first directory sector beyond the file": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(0x00ffffff, 48)),
      reason: "bad-sector",
    },
    "a FAT sector id in the header beyond the file": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(0x00ffffff, 76)),
      reason: "bad-sector",
    },
    "a FAT sector count of zero": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(0, 44)),
      reason: "bad-fat",
    },
    "a stream declared larger than the whole file": {
      bytes: withHeader((bytes) =>
        bytes.writeUInt32LE(plain.bytes.length * 4, entryOffset(plain.layout, "WordDocument") + 120),
      ),
      reason: "bad-stream",
    },
    "a root entry that is not a root": {
      bytes: withHeader((bytes) => {
        bytes[(plain.layout.directorySectors[0] + 1) * 512 + 66] = 2;
      }),
      reason: "bad-directory",
    },
    "a directory tree that loops back to the root": {
      bytes: withHeader((bytes) => bytes.writeUInt32LE(0, entryOffset(plain.layout, "WordDocument") + 68)),
      reason: "bad-directory",
    },
    "a container with no Word, Excel or PowerPoint stream": {
      bytes: () => build([{ path: "Contents", data: seededBytes(100, 1) }]).bytes,
      reason: "not-office",
    },
    "a Word stream that does not start with a FIB": {
      bytes: () => build([{ path: "WordDocument", data: seededBytes(1024, 6) }]).bytes,
      reason: "bad-office",
    },
    "a workbook that does not start with a BOF record": {
      bytes: () => build([{ path: "Workbook", data: seededBytes(600, 2) }]).bytes,
      reason: "bad-office",
    },
    "a Current User stream with an unknown header token": {
      bytes: currentUserCase((currentUser) => currentUser.writeUInt32LE(0x12345678, 12)),
      reason: "bad-office",
    },
    "a Current User offset past the end of the PowerPoint stream": {
      bytes: currentUserCase((currentUser, document) => currentUser.writeUInt32LE(document.length + 100, 16)),
      reason: "bad-office",
    },
    "no UserEditAtom at the Current User offset": {
      bytes: currentUserCase((currentUser) => currentUser.writeUInt32LE(0, 16)),
      reason: "bad-office",
    },
    "the PowerPoint stream cut short (the legacy-truncated fixture)": {
      bytes: () => fixture("legacy-truncated.ppt").build(),
      reason: "bad-stream",
      extension: ".ppt",
    },
    "the last four sectors of a 16 KiB PowerPoint stream cut away": {
      bytes: () => ppt.bytes.subarray(0, ppt.bytes.length - 2048),
      reason: "bad-sector",
      extension: ".ppt",
    },
    "a WPS-named file that is truncated": {
      bytes: () => ppt.bytes.subarray(0, ppt.bytes.length - 6144),
      reason: "bad-stream",
      extension: ".dps",
    },
  };

  for (const [label, { bytes, reason, extension = ".doc" }] of Object.entries(cases)) {
    test(`${label} is not ok (${reason})`, () => {
      const input = bytes();
      /** @type {LegacyClassification | undefined} */
      let outcome;
      assert.doesNotThrow(() => {
        outcome = timed(label, () => classifyLegacyOffice(input, extension));
      });
      const result = /** @type {LegacyClassification} */ (outcome);
      assert.deepEqual(shape(result), { ...REJECTED, vendor: extension === ".dps" ? "wps" : "ms" });
      assert.equal(result.reason, reason);
    });
  }

  test("exactly 4096 directory entries are still accepted", () => {
    const bytes = build([...wordItems(), ...filler(4092)]).bytes;
    assert.equal(classifyLegacyOffice(bytes, ".doc").ok, true);
  });

  test("single-byte damage to the header and directory never throws, hangs or gets past the budget", () => {
    const noise = seededBytes(6000, 4242);
    let rejected = 0;
    for (const name of ["legacy-plain.doc", "legacy-plain.xls", "legacy-plain.ppt", "wps-secure.dps", "legacy.et"]) {
      const original = fixture(name).build();
      for (let round = 0; round < 120; round += 1) {
        const bytes = Buffer.from(original);
        for (let hit = 0; hit < 1 + (round % 4); hit += 1) {
          const at = round * 10 + hit * 2;
          const position = (noise[at] * 256 + noise[at + 1]) % Math.min(bytes.length, 2048);
          bytes[position] ^= noise[at + 5] | 1;
        }
        const result = timed(`${name} #${round}`, () => classifyLegacyOffice(bytes, extensionOf(name)));
        if (!result.ok) {
          rejected += 1;
          assert.notEqual(result.reason, "unreadable", `${name} #${round} escaped as an unexpected error`);
        }
      }
    }
    assert.ok(rejected > 20, `the damage actually broke some files (${rejected})`);
  });

  test("random bytes behind a valid signature are rejected quickly", () => {
    const signature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const bytes = Buffer.concat([signature, seededBytes(60_000, 5)]);
    assert.equal(timed("random", () => classifyLegacyOffice(bytes, ".doc")).ok, false);
  });
});

describe("large files", () => {
  test("a 16 MiB Word file, a 12 MiB workbook and a 16 MiB deck each classify in under 100 ms", () => {
    const word = container(wordItems({ size: 16 * 1024 * 1024 }));
    const sheet = container(excelItems({ size: 12 * 1024 * 1024 }));
    const deck = container(pptItems({ size: 16 * 1024 * 1024, vba: "macros" }));
    assert.equal(timed("16 MiB doc", () => classifyLegacyOffice(word, ".doc")).family, "doc");
    assert.equal(timed("12 MiB xls", () => classifyLegacyOffice(sheet, ".xls")).family, "xls");
    assert.equal(timed("16 MiB ppt", () => classifyLegacyOffice(deck, ".ppt")).macro, true);
  });
});
