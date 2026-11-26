/**
 * The write_layout agent tool (masters-layouts §3.20): defines the deck master or one page layout.
 * It shares the write queue and the kind/theme-pack refusal with write_page. The domain hand runs
 * the layout checks and records the layout.revision-committed fact.
 */
import type { CommandReceipt } from "@open-slidestudio/presentation-run";
import { normalizePageFonts, writeLayoutJsonSchema } from "@open-slidestudio/pptd-v2";
import { rejectKindThemePack } from "./kind-theme-gate.js";
import { expandComponentArgs, recordComponentUses } from "./template-components.js";
import { normalizeWritePageElement, unwrapToolValue } from "./write-page.js";
import { writePageSerial } from "./write-page-serial.js";
import type { SlideToolDefinition } from "./contract.js";
import {
  isLeaseRefusalData,
  present,
  result,
  runAuthorizedSideEffect,
  sessionKeyOf,
  slideTool,
  type SlideToolRuntimeDeps,
} from "./tool-kit.js";

type Json = Record<string, unknown>;

function layoutArgs(args: Json): Json {
  const clean = unwrapToolValue(args) as Json;
  if (typeof clean.elements === "string") {
    try {
      clean.elements = JSON.parse(clean.elements);
    } catch {
      // The domain reports a non-array elements value with the stable layout_shape refusal.
    }
  }
  if (Array.isArray(clean.elements)) clean.elements = clean.elements.map(normalizeWritePageElement);
  return clean;
}

/** The model-facing outcome: the domain's written, skipped-identical or rejected result. */
function layoutOutcome(receipt: CommandReceipt, fontNotes: string[]): Json {
  if (!receipt.ok) {
    if (isLeaseRefusalData(receipt.payload)) return receipt.payload;
    return {
      outcome: "rejected",
      error: String(receipt.payload.error ?? "rejected"),
      detail: receipt.detail,
      painted: false,
    };
  }
  // `ok` settles a repeated identical layout as done in the timeline, as a written layout is.
  return { ok: true, ...receipt.payload, ...(fontNotes.length ? { fontNotes } : {}) };
}

export function writeLayoutTool(deps: SlideToolRuntimeDeps): SlideToolDefinition {
  // The provider receives the closed contract; the domain hand still checks every rule it owns.
  return slideTool(deps, {
    name: "write_layout",
    description:
      'Define the deck master (scope master, id main) or one page layout (scope layout) in one call. Use a layout for chrome that repeats on several pages: header line, logo, page number, footer or background. Put that chrome on the layout whose pages show it: every layout inherits the master\'s elements unless showMasterElements is false. Define the deck master first, then each layout, then write the pages. Page numbers: a text element with content.field pageNumber whose text is {page} (or {pages} for the total); never zero-pad it. Whole replacement: send every element. A page whose layoutId names this layout inherits its elements, so never redraw them on the page. Text, shape, image, line and icon elements only, plus a template component reference {elementType:"component", ref:"material:<id>#<componentId>", bounds:[x,y,w,h]} from the template\'s read_material part kit (read it fully first; the template needs the decorations use declared in commit_design), which the Host expands into native elements. SmartArt components are page-only: write_layout refuses them, exactly like chart and table elements. An identical definition returns skipped-identical. The outcome lists pagesUsing and pagesNeedingRender; re-render those pages. Master and layout text is generic chrome: a template sample\'s titles, report names, dates and figures never belong there, and write_layout refuses such text; sample wording goes on pages only.',
    schema: writeLayoutJsonSchema() as Record<string, unknown>,
    closed: true,
    readOnly: false,
    async execute(args, ctx) {
      const sessionId = sessionKeyOf(ctx);
      const { projectRoot } = ctx;
      const packRejected = rejectKindThemePack(projectRoot, {});
      if (packRejected) return result(packRejected);
      const clean = layoutArgs(args as Json);
      const scope = () => ({ projectRoot, contextEpochId: deps.presentation.epochFor(sessionId) });
      const components = expandComponentArgs(clean, "layout", scope);
      if (!components.ok) return result(components.outcome);
      // A layout is slide content: its elements name only the faces in the slide font table, as pages do.
      const fontNotes = normalizePageFonts(clean).map(
        (entry) => `字体 ${JSON.stringify(entry.from)} 改成 ${JSON.stringify(entry.to)}`,
      );
      return writePageSerial.enqueue(sessionId, async () => {
        const receipt = await present(deps, ctx, "write_layout", clean);
        if (receipt.ok) {
          // Only a layout revision can be matched against the delivered layouts; a master write
          // carries none, so its uses stay unbound facts.
          const revision = receipt.payload.scope === "layout" ? receipt.payload.revision : undefined;
          runAuthorizedSideEffect(deps, ctx, () =>
            recordComponentUses(scope, components.uses, {
              layoutId: String(clean.id),
              ...(typeof revision === "number" ? { revision } : {}),
            }),
          );
        }
        return result(layoutOutcome(receipt, fontNotes));
      });
    },
  });
}
