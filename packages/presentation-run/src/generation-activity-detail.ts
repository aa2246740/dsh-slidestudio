const TRACE_DETAIL_MAX = 8_192;
const TRACE_BASE64ISH = /^[A-Za-z0-9+/=_-]+$/;

/**
 * Trace deltas can split a credential at arbitrary byte boundaries. Sanitize
 * the folded value as well as each persisted row so a split Bearer/token value
 * cannot become visible when the UI joins those rows.
 */
function redactTraceDetail(text: string): string {
  if (/^data:[^,]*;base64,/i.test(text.trim())) return "[redacted binary data]";
  if (text.length >= 256 && !/\s/.test(text.trim()) && TRACE_BASE64ISH.test(text.trim())) {
    return "[redacted binary data]";
  }
  return (
    text
      .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi, "[redacted credential]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted credential]")
      .replace(
        /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)\s*[=:]\s*)([^\s,;&]+)/gi,
        "$1[redacted]",
      )
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi,
        "$1[redacted]",
      )
      // A previous delta may already have redacted the credential prefix while
      // the current delta carries the remaining token characters.
      .replace(/(Bearer \[redacted\])(?:[A-Za-z0-9._~+\/-]+=*)/gi, "$1")
      .replace(/(\[redacted credential\])(?:[A-Za-z0-9_-]+)/gi, "$1")
  );
}

export function boundTraceDetail(text: string, max = TRACE_DETAIL_MAX): { detail?: string; truncated?: boolean } {
  const normalized = redactTraceDetail(text).replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return {};
  if (normalized.length <= max) return { detail: normalized };
  return { detail: `${normalized.slice(0, max - 1)}…`, truncated: true };
}
