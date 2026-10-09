export class HttpInputError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        ["127.0.0.1", "::1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export function corsHeaders(req, extraOrigins = []) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || (!isLoopbackOrigin(origin) && !extraOrigins.includes(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type,X-Request-ID",
    "Access-Control-Expose-Headers": "X-Request-ID,X-Export-Report",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

export function assertRequestAllowed(req, extraOrigins = []) {
  if (req.headers.host && !isLoopbackOrigin(`http://${req.headers.host}`)) {
    throw new HttpInputError(421, "unrecognized host");
  }
  if (req.headers.origin && !corsHeaders(req, extraOrigins)["Access-Control-Allow-Origin"]) {
    throw new HttpInputError(403, "origin not allowed");
  }
  if (req.method === "POST" && !/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
    throw new HttpInputError(415, "application/json required");
  }
}

export async function readJsonBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > limit) {
      req.resume();
      throw new HttpInputError(413, "request body too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpInputError(400, "invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpInputError(400, "JSON object required");
  return value;
}

export function safeFilename(value) {
  const filename = String(value || "presentation.pptx").replace(/[\r\n"\\/]/g, "_");
  return filename.slice(0, 160);
}
