import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startPdfImages } from "./pdf-images-start.mjs";

const image = (/** @type {any} */ page) => ({
  page,
  order: 1,
  width: 64,
  height: 64,
  format: "png",
  bytes: Buffer.from([page]),
});
/** @returns {any} */
const result = (/** @type {any} */ pages) => ({
  images: pages.map(image),
  qualifying: pages.length,
  countComplete: true,
  pagesScanned: pages.length,
  pageCount: pages.length,
  skipped: {},
  timedOut: false,
});

describe("VAL-PDF-007: starting the reading of a PDF's pictures apart from awaiting it", () => {
  test("the reading begins at once with the bytes and the abort signal", async () => {
    const controller = new AbortController();
    /** @type {any[]} */ const calls = [];
    startPdfImages(
      async (input) => {
        calls.push(input);
        return result([]);
      },
      new Uint8Array([1, 2, 3]),
      controller.signal,
    );
    assert.equal(calls.length, 1, "the runner was entered synchronously");
    assert.equal(calls[0].signal, controller.signal);
    assert.deepEqual([...calls[0].bytes], [1, 2, 3]);
  });

  test("a follower that arrives late is replayed what came before and then follows the rest", async () => {
    /** @type {any} */
    let emit;
    const extraction = startPdfImages(
      ({ onImages }) =>
        new Promise((resolve) => {
          emit = (/** @type {any} */ pages, /** @type {any} */ done) => {
            onImages?.(pages.map(image));
            if (done) resolve(result([1, 2, 3]));
          };
        }),
      new Uint8Array(),
    );
    emit([1]);
    /** @type {any[]} */ const seen = [];
    const unfollow = extraction.follow((images) => seen.push(images.map((entry) => entry.page)));
    assert.deepEqual(seen, [[1]]);
    emit([2]);
    unfollow();
    emit([3], true);
    await extraction.result;
    assert.deepEqual(seen, [[1], [2]], "nothing is delivered after unfollowing");
  });

  test("a failing or throwing runner is a rejection of result, not an unhandled one", async () => {
    const failing = startPdfImages(async () => {
      throw new Error("child crashed");
    }, new Uint8Array());
    await assert.rejects(failing.result, /child crashed/);
    const throwing = startPdfImages(() => {
      throw new Error("sync failure");
    }, new Uint8Array());
    await assert.rejects(throwing.result, /sync failure/);
  });
});
