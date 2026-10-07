#!/usr/bin/env node
/**
 * Mock OpenAI-compatible image API for SlideStudio generate_image testing.
 * POST /v1/images/generations (also /openai/v1/images/generations)
 *   body: { model, prompt, size: "WxH", n, response_format, aspect_ratio? }
 *   → { created, data: [{ b64_json }] }  (real PNG, size honored)
 * GET /mock-image/log → JSON array of every request seen.
 * No real image model: paints a deterministic watercolor-ish gradient PNG.
 */
import http from "node:http";
import zlib from "node:zlib";

const PORT = Number(process.env.MOCK_IMAGE_PORT || 18181);
const LOG = [];

// ---- minimal PNG encoder (RGBA, no deps) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function makePng(width, height, seed) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4;
      // soft gradient blobs — deterministic per seed
      const w1 = Math.sin((x / width) * 6.28 + seed) * 0.5 + 0.5;
      const w2 = Math.sin((y / height) * 6.28 + seed * 1.7) * 0.5 + 0.5;
      raw[i] = Math.round(120 + 100 * w1);
      raw[i + 1] = Math.round(140 + 80 * w2);
      raw[i + 2] = Math.round(170 + 70 * (1 - w1 * w2));
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function parseSize(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!m) return { width: 1024, height: 1024 };
  const width = Math.min(2048, Math.max(16, Number(m[1])));
  const height = Math.min(2048, Math.max(16, Number(m[2])));
  return { width, height };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/mock-image/log") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(LOG, null, 2));
    return;
  }
  if (req.method === "GET" && url.pathname === "/mock-image/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, calls: LOG.length }));
    return;
  }
  const isGenerations =
    req.method === "POST" && /\/images\/generations\/?$/.test(url.pathname);
  if (!isGenerations) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    const { width, height } = parseSize(payload.size);
    const seed = Array.from(String(payload.prompt || "")).reduce(
      (a, ch) => (a + ch.charCodeAt(0)) % 997,
      0,
    );
    const png = makePng(width, height, seed);
    const entry = {
      at: new Date().toISOString(),
      path: url.pathname,
      model: payload.model,
      size: payload.size,
      width,
      height,
      n: payload.n,
      response_format: payload.response_format,
      aspect_ratio: payload.aspect_ratio,
      prompt: String(payload.prompt || "").slice(0, 300),
      auth: req.headers.authorization ? "present" : "missing",
    };
    LOG.push(entry);
    console.log(`[mock-image] #${LOG.length} ${payload.model} ${width}x${height} :: ${entry.prompt.slice(0, 80)}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: png.toString("base64"), revised_prompt: payload.prompt }],
      }),
    );
  });
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-image] OpenAI-format image API on http://127.0.0.1:${PORT}/v1/images/generations`);
});
