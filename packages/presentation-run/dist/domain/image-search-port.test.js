import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createImageSearchPort, imageSearchConfigured, imageSearchConfigFromEnv, } from "./image-search-port.js";
const JPEG = Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(80, 7)]);
function okJson(payload) {
    return new Response(JSON.stringify(payload), { status: 200 });
}
describe("image search presets", () => {
    it("generic keeps the POST {query} contract", async () => {
        const calls = [];
        const port = createImageSearchPort({ url: "https://search.test/images", apiKey: "k" }, {
            fetch: async (url, init) => {
                calls.push({ url: String(url), init });
                if (calls.length === 1) {
                    return okJson({
                        images: [{ b64_json: JPEG.toString("base64"), attribution: "x" }],
                    });
                }
                return new Response("", { status: 404 });
            },
        });
        const hit = await port.search("松鼠");
        assert.equal(calls[0]?.init?.method, "POST");
        assert.equal(JSON.parse(String(calls[0]?.init?.body)).query, "松鼠");
        assert.equal("kind" in hit, false);
    });
    it("pixabay builds a GET with key+query params and maps hits[]", async () => {
        const calls = [];
        const port = createImageSearchPort({
            url: "https://pixabay.com",
            apiKey: "pk",
            preset: "pixabay",
        }, {
            fetch: async (url, init) => {
                calls.push(String(url));
                if (calls.length === 1) {
                    assert.equal(init?.method ?? "GET", "GET");
                    return okJson({
                        hits: [
                            {
                                largeImageURL: "https://cdn.pixabay.com/x_1280.jpg",
                                imageWidth: 1280,
                                imageHeight: 853,
                                user: "jeremy888",
                            },
                        ],
                    });
                }
                return new Response(JPEG, {
                    status: 200,
                    headers: { "content-type": "image/jpeg" },
                });
            },
        });
        const hit = await port.search("松鼠");
        const u = new URL(calls[0] ?? "");
        assert.equal(u.hostname, "pixabay.com");
        assert.equal(u.pathname, "/api");
        assert.equal(u.searchParams.get("key"), "pk");
        assert.equal(u.searchParams.get("q"), "松鼠");
        assert.equal(u.searchParams.get("image_type"), "photo");
        assert.equal("kind" in hit, false);
        if ("kind" in hit)
            throw new Error("expected bytes");
        assert.equal(hit.attribution, "Pixabay · jeremy888");
        assert.equal(hit.mime, "image/jpeg");
    });
    it("pexels uses Authorization header and photos[].src", async () => {
        const calls = [];
        const port = createImageSearchPort({ url: "https://api.pexels.com", apiKey: "pxk", preset: "pexels" }, {
            fetch: async (url, init) => {
                calls.push({ url: String(url), init });
                if (calls.length === 1) {
                    return okJson({
                        photos: [
                            {
                                src: { large2x: "https://images.pexels.com/big.jpg" },
                                width: 1600,
                                height: 900,
                                photographer: "Ann",
                            },
                        ],
                    });
                }
                return new Response(JPEG, { status: 200 });
            },
        });
        const hit = await port.search("forest");
        assert.equal(calls[0]?.url, "https://api.pexels.com/v1/search?query=forest&per_page=8");
        assert.equal((calls[0]?.init?.headers).Authorization, "pxk");
        if ("kind" in hit)
            throw new Error("expected bytes");
        assert.equal(hit.attribution, "Pexels · Ann");
    });
    it("unsplash maps results[].urls.regular with client_id", async () => {
        const calls = [];
        const port = createImageSearchPort({ url: "https://api.unsplash.com", apiKey: "uk", preset: "unsplash" }, {
            fetch: async (url) => {
                calls.push(String(url));
                if (calls.length === 1) {
                    return okJson({
                        results: [
                            {
                                urls: { regular: "https://images.unsplash.com/r.jpg" },
                                width: 1200,
                                height: 800,
                                user: { name: "Bo" },
                            },
                        ],
                    });
                }
                return new Response(JPEG, { status: 200 });
            },
        });
        const hit = await port.search("sea");
        const u = new URL(calls[0] ?? "");
        assert.equal(u.pathname, "/search/photos");
        assert.equal(u.searchParams.get("client_id"), "uk");
        if ("kind" in hit)
            throw new Error("expected bytes");
        assert.equal(hit.attribution, "Unsplash · Bo");
    });
    it("bing sends Ocp-Apim-Subscription-Key and maps value[].contentUrl", async () => {
        const calls = [];
        const port = createImageSearchPort({ url: "https://api.bing.microsoft.com", apiKey: "bk", preset: "bing" }, {
            fetch: async (url, init) => {
                calls.push({ url: String(url), init });
                if (calls.length === 1) {
                    return okJson({
                        value: [
                            {
                                contentUrl: "https://img.example/b.jpg",
                                width: 640,
                                height: 480,
                                hostPageUrl: "https://blog.example/post",
                            },
                        ],
                    });
                }
                return new Response(JPEG, { status: 200 });
            },
        });
        const hit = await port.search("ocean");
        assert.equal(calls[0]?.url, "https://api.bing.microsoft.com/v7.0/images/search?q=ocean&count=8&safeSearch=Strict");
        assert.equal((calls[0]?.init?.headers)["Ocp-Apim-Subscription-Key"], "bk");
        if ("kind" in hit)
            throw new Error("expected bytes");
        assert.equal(hit.attribution, "Bing Images · blog.example");
    });
    it("template preset interpolates {{query}} and follows imagePath", async () => {
        const calls = [];
        const port = createImageSearchPort({
            url: "https://photos.corp/api/find",
            preset: "template",
            template: {
                method: "POST",
                headers: { "X-Token": "{{key}}" },
                body: '{"term":"{{query}}"}',
                imagePath: "data.hits.0.src",
                attribution: "内网图库",
            },
        }, {
            fetch: async (url, init) => {
                calls.push({ url: String(url), init });
                return okJson({ data: { hits: [{ src: JPEG.toString("base64") }] } });
            },
        });
        const hit = await port.search("山门");
        assert.equal(JSON.parse(String(calls[0]?.init?.body)).term, "山门");
        assert.equal((calls[0]?.init?.headers)["X-Token"], "");
        if ("kind" in hit)
            throw new Error("expected bytes");
        assert.equal(hit.attribution, "内网图库");
        assert.equal(hit.bytes.equals(JPEG), true);
    });
    it("named presets require an apiKey to count as configured", () => {
        assert.equal(imageSearchConfigured({ url: "https://x", preset: "pixabay" }), false);
        assert.equal(imageSearchConfigured({ url: "https://x", preset: "pixabay", apiKey: "k" }), true);
        assert.equal(imageSearchConfigured({ url: "https://x", preset: "generic" }), true);
        assert.equal(imageSearchConfigured({ url: "https://x", preset: "template" }), true);
    });
    it("reads preset + template from env", () => {
        const cfg = imageSearchConfigFromEnv({
            SLIDESTUDIO_IMAGE_SEARCH_URL: "https://pixabay.com/api/",
            SLIDESTUDIO_IMAGE_SEARCH_KEY: "pk",
            SLIDESTUDIO_IMAGE_SEARCH_PRESET: "pixabay",
        });
        assert.equal(cfg.preset, "pixabay");
        assert.equal(cfg.url, "https://pixabay.com/api/");
    });
});
//# sourceMappingURL=image-search-port.test.js.map