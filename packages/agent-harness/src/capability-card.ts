/**
 * Capability card: advertised to the agent BEFORE it designs.
 * Search / generate / vision / raster are facts, not hopes.
 */
import { imageConfigured, imageConfigFromEnv } from "./image-port.js";
import { imageSearchConfigured, imageSearchConfigFromEnv } from "./image-search-port.js";
import { researchConfigFromEnv } from "./research-port.js";
import { llmConfigFromEnv } from "./llm-port.js";
import { piAvailable } from "./pi-available.js";
import { resolvePiAuth, type PiAuthStatus } from "./pi-auth.js";

export type ResearchCap = {
  mode: "attachments-gap" | "http";
  configured: boolean;
};

export type ImageCap = {
  configured: boolean;
  via: "http" | "none";
};

export type VisionCap = {
  mode: "main-model" | "none";
  note: string;
};

export type RasterCap = {
  mode: "native-slide" | "unavailable";
  note: string;
};

export type RuntimeCap = {
  kind: "agent-loop" | "pi" | "playbook" | "dsh";
  piAvailable: boolean;
  piNote: string;
  piAuth?: PiAuthStatus;
};

export type CapabilityCard = {
  research: ResearchCap;
  imageSearch: ImageCap;
  imageGenerate: ImageCap;
  vision: VisionCap;
  pageRaster: RasterCap;
  runtime: RuntimeCap;
  mediaPolicy: "optional";
};

export type DetectCapabilitiesOpts = {
  env?: NodeJS.ProcessEnv;
  rasterAvailable?: boolean;
  pi?: ReturnType<typeof piAvailable>;
  piAuth?: PiAuthStatus;
  runtimeKind?: RuntimeCap["kind"];
  /** Selected Pi model input modalities from session.getState(). */
  piModelInput?: readonly string[];
};

export function detectCapabilities(opts: DetectCapabilitiesOpts = {}): CapabilityCard {
  const env = opts.env ?? process.env;
  const research = researchConfigFromEnv(env);
  const search = imageSearchConfigFromEnv(env);
  const generate = imageConfigFromEnv(env);
  const llm = llmConfigFromEnv(env);
  const pi = opts.pi ?? piAvailable(env);
  const piAuth = opts.piAuth ?? resolvePiAuth(env);
  const visionOff = env.SLIDESTUDIO_LLM_IMAGE === "0";
  const llmReady = Boolean(llm?.baseUrl);
  const piVision = opts.piModelInput?.includes("image") === true;
  const visionReady = opts.runtimeKind === "pi" ? piVision : llmReady && !visionOff;
  const rasterOn = opts.rasterAvailable ?? Boolean(env.SLIDESTUDIO_EDITOR_URL?.trim());

  return {
    research: research ? { mode: "http", configured: true } : { mode: "attachments-gap", configured: false },
    imageSearch: {
      configured: imageSearchConfigured(search),
      via: imageSearchConfigured(search) ? "http" : "none",
    },
    imageGenerate: {
      configured: imageConfigured(generate),
      via: imageConfigured(generate) ? "http" : "none",
    },
    vision: visionReady
      ? {
          mode: "main-model",
          note:
            opts.runtimeKind === "pi"
              ? "The selected Pi model declares image input. render_page returns a real PNG image content block."
              : "Main chat may accept image_url parts. If it cannot, admit you did not see the slide.",
        }
      : {
          mode: "none",
          note:
            opts.runtimeKind === "pi"
              ? "The selected Pi model does not declare image input. Production visual review must fail closed."
              : "No vision. Structural QA only. Do not pretend you saw the page.",
        },
    pageRaster: rasterOn
      ? {
          mode: "native-slide",
          note: "render_page screenshots native #slide. Not official iframe. Not background-only PNG.",
        }
      : {
          mode: "unavailable",
          note: "No editor URL / Playwright. You cannot see the page. Do not claim visual QA.",
        },
    runtime: {
      kind: opts.runtimeKind ?? "agent-loop",
      piAvailable: pi.available,
      piNote: pi.note,
      piAuth,
    },
    mediaPolicy: "optional",
  };
}

export function formatCapabilityCard(card: CapabilityCard): string {
  const yn = (on: boolean) => (on ? "YES" : "NO");
  return [
    "CAPABILITY CARD — read this before you design. Do not assume a hand you do not have.",
    `research: ${card.research.mode} (http=${yn(card.research.configured)}). Attachments → optional intranet → 勾股 classroom_common → gap.`,
    `imageSearch: ${yn(card.imageSearch.configured)} via ${card.imageSearch.via}.`,
    `imageGenerate: ${yn(card.imageGenerate.configured)} via ${card.imageGenerate.via}.`,
    `vision: ${card.vision.mode}. ${card.vision.note}`,
    `pageRaster: ${card.pageRaster.mode}. ${card.pageRaster.note}`,
    `runtime: ${card.runtime.kind}. Pi ${card.runtime.piAvailable ? "available" : "not installed"} — ${card.runtime.piNote}. Auth ${card.runtime.piAuth?.source ?? "none"} / ${card.runtime.piAuth?.kind ?? "none"}.`,
    "mediaPolicy: optional. A complete deck may have zero media/ files.",
    "Image source priority: configured search → configured generate → no-image mode (text / shape / table / chart).",
    "If neither search nor generate is configured, do not call those tools. Do not write src.",
    "If you write src, the file must already exist.",
    "Editing and export are built into this product: the deck opens in its own editor, where the user reviews pages, edits objects, leaves comments, and exports PPTX/PDF/PNG from the export menu. Export by calling export_deck. Stay inside this product's own tools — no local toolchain, no external editor, no shell.",
    "Hard guardrail: never name a script, command, local address, or file-system path to the user.",
  ].join("\n");
}
