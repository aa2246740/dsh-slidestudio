import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateRequest,
  interpolate,
  jsonPath,
} from "./endpoint-template.js";

describe("endpoint template engine", () => {
  it("interpolates {{vars}} with spaces and missing vars as empty", () => {
    const out = interpolate("https://x?q={{ query }}&k={{key}}&z={{nope}}", {
      query: "松鼠",
      key: "abc",
    });
    assert.equal(out, `https://x?q=${encodeURIComponent("松鼠") === "%E6%9D%BE%E9%BC%A0" ? "松鼠" : "松鼠"}&k=abc&z=`);
  });

  it("jsonPath walks objects and array indexes", () => {
    const obj = { output: { results: [{ url: "u1" }, { url: "u2" }] } };
    assert.equal(jsonPath(obj, "output.results.0.url"), "u1");
    assert.equal(jsonPath(obj, "output.results.1.url"), "u2");
    assert.equal(jsonPath(obj, "output.results.5.url"), undefined);
    assert.equal(jsonPath(obj, "missing.deep"), undefined);
  });

  it("buildTemplateRequest defaults to POST when a body is set", () => {
    const req = buildTemplateRequest(
      { url: "https://a/b", body: '{"q":"{{query}}"}', headers: { "X-K": "{{key}}" } },
      { query: "猫", key: "kk" },
    );
    assert.equal(req.init.method, "POST");
    assert.equal(req.init.body, '{"q":"猫"}');
    assert.equal((req.init.headers as Record<string, string>)["X-K"], "kk");
    assert.equal((req.init.headers as Record<string, string>)["content-type"], "application/json");
  });

  it("GET template puts everything in the URL", () => {
    const req = buildTemplateRequest(
      { url: "https://a/find?term={{query}}&k={{key}}", method: "GET" },
      { query: "cat", key: "kk" },
    );
    assert.equal(req.url, "https://a/find?term=cat&k=kk");
    assert.equal(req.init.method, "GET");
    assert.equal(req.init.body, undefined);
  });
});
