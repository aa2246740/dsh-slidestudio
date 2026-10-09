import type { Deck } from "@open-slidestudio/pptd";
import type { AgentReference, AgentStep } from "@open-slidestudio/agent-core";
import { monitoredFetch } from "./logger";

export type GenerateResponse = {
  deck: Deck;
  versionId: string;
  versionNumber: number;
  versionLabel: string;
  summary: string;
  steps: AgentStep[];
  provider: string;
  displayName: string;
  pinBatch?: {
    succeededPinIds: string[];
    failedPins: Array<{ id: string; reason: string }>;
  };
  error?: string;
};

export type HealthResponse = {
  ok: boolean;
  llm: boolean;
  source: string | null;
  model: string | null;
};

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await monitoredFetch(`${API_BASE}/api/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json() as Promise<HealthResponse>;
}

export async function generateDeckRemote(input: {
  prompt: string;
  title?: string;
  templateId?: string;
  modelId?: string;
  references?: AgentReference[];
  baseDeck?: Deck;
  baseVersionId?: string;
  baseVersionNumber?: number;
  pins?: Array<{
    id: string;
    slideId: string;
    x: number;
    y: number;
    text: string;
  }>;
}): Promise<GenerateResponse> {
  const res = await monitoredFetch(`${API_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as GenerateResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `generate failed (${res.status})`);
  }
  return data;
}
