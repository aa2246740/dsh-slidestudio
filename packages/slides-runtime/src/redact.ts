/**
 * Display-safe text and value redaction shared by faults, the session log and
 * the public trace. Pattern redaction catches common credential shapes;
 * registered secrets (API keys this process handled) are removed verbatim.
 */
const SECRET_KEY =
  /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)(?:$|[_-])/i;
const SECRET_SUFFIX =
  /(?:apikey|accesstoken|refreshtoken|token|secret|password|passwd|credential|authorization|cookie|privatekey)$/;
const BASE64ISH = /^[A-Za-z0-9+/=_-]+$/;
const MIN_REGISTERED_SECRET = 8;

const registeredSecrets = new Set<string>();

/** Remember an exact secret value (e.g. a configured API key) so it never reaches disk or UI. */
export function registerSecret(value: string | undefined): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length >= MIN_REGISTERED_SECRET) registeredSecrets.add(trimmed);
}

export function scrubRegisteredSecrets(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function isSecretKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY.test(key) || SECRET_SUFFIX.test(compact);
}

/** Redact credential-shaped substrings and opaque binary blobs. */
export function redactText(value: string): string {
  const trimmed = value.trim();
  if (/^data:[^,]*;base64,/i.test(trimmed)) return "[redacted binary data]";
  if (trimmed.length >= 256 && !/\s/.test(trimmed) && BASE64ISH.test(trimmed)) return "[redacted binary data]";
  const patterned = value
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi, "[redacted credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted credential]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\s*[=:]\s*)([^\s,;&]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi,
      "$1[redacted]",
    );
  return scrubRegisteredSecrets(patterned);
}

/** Deep-redact a JSON-like value: secret-named keys are blanked, strings are pattern-redacted. */
export function redactValue(value: unknown, key?: string, ancestors = new Set<object>()): unknown {
  if (key && isSecretKey(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[redacted circular value]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, ancestors));
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(child, childKey, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
