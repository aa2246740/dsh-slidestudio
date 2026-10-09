import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { assertRequestAllowed, corsHeaders, isLoopbackOrigin, readJsonBody, safeFilename } from "./http-input.mjs";

describe("legacy API input guards", () => {
  it("allows only loopback or explicit trusted origins", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:1234",
      "http://[::1]:5173",
      "https://test.localhost",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
    for (const origin of ["http://localhost.attacker.test", "file:///private", "not a URL"]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
    expect(corsHeaders({ headers: {} })).toEqual({});
    expect(
      corsHeaders({ headers: { origin: "https://trusted.test" } }, ["https://trusted.test"])[
        "Access-Control-Allow-Origin"
      ],
    ).toBe("https://trusted.test");
    expect(corsHeaders({ headers: { origin: "https://attacker.test" } })).toEqual({});
  });
  it("requires JSON and rejects cross-site mutations before loading a provider", () => {
    expect(() =>
      assertRequestAllowed({ method: "POST", headers: { "content-type": "application/json; charset=utf-8" } }),
    ).not.toThrow();
    expect(() => assertRequestAllowed({ method: "POST", headers: {} })).toThrow("application/json");
    expect(() => assertRequestAllowed({ method: "POST", headers: { origin: "https://attacker.test" } })).toThrow(
      "origin not allowed",
    );
  });
  it("bounds JSON bytes and rejects malformed/non-object payloads", async () => {
    expect(await readJsonBody(Readable.from([]))).toEqual({});
    expect(await readJsonBody(Readable.from([Buffer.from('{"v":'), Buffer.from("1}")]))).toEqual({ v: 1 });
    await expect(readJsonBody(Readable.from(["broken"]))).rejects.toMatchObject({ statusCode: 400 });
    for (const value of ["null", "[]", '"string"']) {
      await expect(readJsonBody(Readable.from([value]))).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(readJsonBody(Readable.from(['{"oversize":1}']), 4)).rejects.toMatchObject({ statusCode: 413 });
  });
  it("keeps download filenames safe for HTTP headers", () => {
    expect(safeFilename('a"\r\n/private\\name.pptx')).toBe("a____private_name.pptx");
    expect(safeFilename()).toBe("presentation.pptx");
    expect(safeFilename("a".repeat(200))).toHaveLength(160);
  });
});
