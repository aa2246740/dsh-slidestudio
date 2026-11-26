/**
 * Pluggable research. Default is airgap (attachments + classroom_common + gap).
 * Optional intranet URL — never a public-web default.
 */
import { runResearch, type ResearchResult } from "./agent-tools.js";

export type ResearchQuery = {
  query: string;
  brief: string;
  referenceText?: string;
};

export type ResearchPort = {
  search: (input: ResearchQuery) => Promise<ResearchResult>;
};

export type ResearchPortConfig = {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
};

export function researchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResearchPortConfig | undefined {
  const url = env.SLIDESTUDIO_RESEARCH_URL?.trim();
  if (!url) return undefined;
  return {
    url,
    apiKey: env.SLIDESTUDIO_RESEARCH_API_KEY?.trim() || undefined,
    timeoutMs: Number(env.SLIDESTUDIO_RESEARCH_TIMEOUT_MS) || 20_000,
  };
}

export function parseResearchHit(raw: unknown): ResearchResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const facts = Array.isArray(o.facts)
    ? o.facts
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const citations = Array.isArray(o.citations)
    ? o.citations
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const gap = typeof o.gap === "string" && o.gap.trim() ? o.gap.trim() : undefined;
  const note = typeof o.note === "string" && o.note.trim() ? o.note.trim() : "内网检索，不是公网。";
  if (!facts.length && !gap) return undefined;
  return {
    source: facts.length ? "intranet" : "none",
    citations,
    facts,
    note,
    gap,
  };
}

export function createLocalResearchPort(): ResearchPort {
  return {
    async search({ query, brief, referenceText }) {
      return runResearch(query, brief, referenceText);
    },
  };
}

export function createHttpResearchPort(
  config: ResearchPortConfig,
  fallback: ResearchPort = createLocalResearchPort(),
): ResearchPort {
  return {
    async search(input) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), config.timeoutMs ?? 20_000);
        let res: Response;
        try {
          res = await fetch(config.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            },
            signal: ac.signal,
            body: JSON.stringify({ query: input.query, brief: input.brief }),
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`research HTTP ${res.status}`);
        const hit = parseResearchHit(await res.json());
        if (hit) return hit;
      } catch {
        /* degrade — never invent a citation */
      }
      return fallback.search(input);
    },
  };
}
