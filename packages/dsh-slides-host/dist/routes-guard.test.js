import { it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleSlidesRequest } from "./routes.js";
/** Only the request guard runs before an unknown path answers 404. */
function invoke(headers, body = "", url = "/slides/sessions/guard-probe/unknown-action", method = "POST", runtime = { workspaceRoot: process.cwd() }) {
    return new Promise((resolve, reject) => {
        const req = Readable.from(body ? [Buffer.from(body)] : []);
        req.method = method;
        req.url = url;
        req.headers = { host: "127.0.0.1:13080", ...headers };
        const res = {
            statusCode: 0,
            headersSent: false,
            writeHead(status) {
                this.statusCode = status;
                this.headersSent = true;
            },
            setHeader() { },
            end(chunk) {
                try {
                    resolve({
                        status: this.statusCode,
                        json: chunk == null ? {} : JSON.parse(String(chunk)),
                    });
                }
                catch (error) {
                    reject(error);
                }
            },
        };
        handleSlidesRequest(runtime, req, res);
    });
}
it("lets a bodyless POST through: browsers send Content-Length: 0 on stop", async () => {
    const result = await invoke({ "content-length": "0" });
    assert.notEqual(result.json.error, "mutating requests require application/json");
    assert.notEqual(result.status, 403);
});
it("still rejects a mutating body that is not JSON", async () => {
    const plain = await invoke({ "content-type": "text/plain", "content-length": "5" }, "hello");
    assert.equal(plain.status, 403);
    assert.equal(plain.json.error, "mutating requests require application/json");
    const untyped = await invoke({ "content-length": "5" }, "hello");
    assert.equal(untyped.status, 403);
    const chunked = await invoke({ "transfer-encoding": "chunked" }, "hello");
    assert.equal(chunked.status, 403);
});
it("serves runtime status, starts provisioning asynchronously, and rejects foreign origins", async () => {
    let phase = "failed";
    let starts = 0;
    const runtime = {
        workspaceRoot: process.cwd(),
        renderRuntime: () => ({ phase }),
        startRenderRuntime: async () => {
            starts += 1;
            phase = "installing";
        },
    };
    const get = await invoke({}, "", "/slides/runtime", "GET", runtime);
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { phase: "failed" });
    const post = await invoke({ "content-type": "application/json", "content-length": "0" }, "", "/slides/runtime", "POST", runtime);
    assert.equal(post.status, 200);
    assert.deepEqual(post.json, { phase: "installing" });
    assert.equal(starts, 1);
    const rejected = await invoke({ origin: "https://foreign.example", "content-type": "application/json", "content-length": "0" }, "", "/slides/runtime", "POST", runtime);
    assert.equal(rejected.status, 403);
    assert.equal(starts, 1);
});
it("fails closed when a runtime status or setup adapter is unavailable", async () => {
    const runtime = { workspaceRoot: process.cwd() };
    const get = await invoke({}, "", "/slides/runtime", "GET", runtime);
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, {
        phase: "failed",
        error: "Render runtime status is unavailable.",
    });
    const post = await invoke({ "content-type": "application/json", "content-length": "0" }, "", "/slides/runtime", "POST", runtime);
    assert.equal(post.status, 200);
    assert.deepEqual(post.json, {
        phase: "failed",
        error: "Render runtime setup is unavailable.",
    });
});
//# sourceMappingURL=routes-guard.test.js.map