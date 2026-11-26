import { record } from "./write-page-diagnostics.js";

/**
 * Optional `write_page.provenance` declaration: the Agent states where a
 * page's figures come from. The Host verifies declared quotes against the
 * chunks read this session and records the declaration in the run ledger.
 * Provenance is runtime metadata only — it is never written into the page
 * YAML (PPTD v2 stays the single document source of truth).
 */

export type ProvenanceBasis = "material" | "mock" | "mixed" | "own";

export type ProvenanceMaterialRef = Readonly<{
  materialId: string;
  pages?: string;
}>;

export type ProvenanceQuotedValue = Readonly<{
  value: string;
  sourcePage?: number;
  sourcePeriod?: string;
}>;

export type ProvenanceDeclaration = Readonly<{
  basis: ProvenanceBasis;
  materials?: readonly ProvenanceMaterialRef[];
  quoted?: readonly ProvenanceQuotedValue[];
  note?: string;
}>;

/** Model-facing shape contract for the optional provenance parameter. The
 * enum is enforced by `canonicalProvenanceIssues` so an invalid basis value
 * is rejected with a Chinese schema error. */
export const PROVENANCE_PROPERTY = {
  type: "object",
  additionalProperties: false,
  description:
    "Optional provenance declaration. basis: material = figures are exact values read from the uploaded materials, mock = all figures are illustrative, mixed = both, own = agent-authored without material figures. materials lists the materials used; quoted lists figures quoted verbatim (each must appear in the chunks read this session, otherwise the result carries a non-blocking check hint). The declaration is recorded in the run ledger; it is never stored in the page file.",
  properties: {
    basis: {
      type: "string",
      required: true as const,
      description: "material | mock | mixed | own.",
    },
    materials: {
      type: "array",
      description: "Materials this page uses, when basis is material or mixed.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          materialId: {
            type: "string",
            required: true as const,
            description: "The id from list_materials.",
          },
          pages: { type: "string", description: 'Source pages used, e.g. "12" or "3-5".' },
        },
      },
    },
    quoted: {
      type: "array",
      description: "Figures quoted verbatim from a material.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: {
            type: "string",
            required: true as const,
            description: 'The exact figure as written on this page, e.g. "89.64%".',
          },
          sourcePage: {
            type: "number",
            description: "1-based page of the source material, when it has pages.",
          },
          sourcePeriod: {
            type: "string",
            description: 'The period label the source gives this value, e.g. "2026年1-2月".',
          },
        },
      },
    },
    note: { type: "string", description: "One short sentence about where the facts come from." },
  },
} as const;

const PROVENANCE_BASES: readonly ProvenanceBasis[] = ["material", "mock", "mixed", "own"];

/** Chinese schema issues for the whole provenance declaration; absent → no issues. */
export function canonicalProvenanceIssues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const rec = record(value);
  if (!rec) return ["$.provenance 必须是一个对象"];
  const issues: string[] = [];
  if (!PROVENANCE_BASES.includes(rec.basis as ProvenanceBasis)) {
    issues.push("$.provenance.basis 必须是 material、mock、mixed、own 之一");
  }
  if (rec.materials !== undefined) {
    if (!Array.isArray(rec.materials)) {
      issues.push("$.provenance.materials 必须是数组");
    } else {
      rec.materials.forEach((item, index) => {
        const row = record(item);
        if (!row) {
          issues.push(`$.provenance.materials[${index}] 必须是对象`);
          return;
        }
        if (typeof row.materialId !== "string" || !row.materialId.trim()) {
          issues.push(`$.provenance.materials[${index}].materialId 必须是非空字符串`);
        }
        if (row.pages !== undefined && typeof row.pages !== "string") {
          issues.push(`$.provenance.materials[${index}].pages 必须是字符串`);
        }
      });
    }
  }
  if (rec.quoted !== undefined) {
    if (!Array.isArray(rec.quoted)) {
      issues.push("$.provenance.quoted 必须是数组");
    } else {
      rec.quoted.forEach((item, index) => {
        const row = record(item);
        if (!row) {
          issues.push(`$.provenance.quoted[${index}] 必须是对象`);
          return;
        }
        if (typeof row.value !== "string" || !row.value.trim()) {
          issues.push(`$.provenance.quoted[${index}].value 必须是非空字符串`);
        }
        if (row.sourcePage !== undefined && (typeof row.sourcePage !== "number" || !Number.isFinite(row.sourcePage))) {
          issues.push(`$.provenance.quoted[${index}].sourcePage 必须是数字`);
        }
        if (row.sourcePeriod !== undefined && typeof row.sourcePeriod !== "string") {
          issues.push(`$.provenance.quoted[${index}].sourcePeriod 必须是字符串`);
        }
      });
    }
  }
  if (rec.note !== undefined && typeof rec.note !== "string") {
    issues.push("$.provenance.note 必须是字符串");
  }
  return issues;
}

/** Typed accessor for a validated declaration; undefined when absent or invalid. */
export function parseProvenanceDeclaration(value: unknown): ProvenanceDeclaration | undefined {
  if (canonicalProvenanceIssues(value).length) return undefined;
  if (value === undefined || value === null) return undefined;
  const rec = record(value) as Record<string, unknown>;
  const declaration: ProvenanceDeclaration = {
    basis: rec.basis as ProvenanceBasis,
    ...(Array.isArray(rec.materials)
      ? {
          materials: rec.materials.map((item) => {
            const row = item as Record<string, unknown>;
            return {
              materialId: String(row.materialId),
              ...(row.pages !== undefined ? { pages: String(row.pages) } : {}),
            };
          }),
        }
      : {}),
    ...(Array.isArray(rec.quoted)
      ? {
          quoted: rec.quoted.map((item) => {
            const row = item as Record<string, unknown>;
            return {
              value: String(row.value),
              ...(row.sourcePage !== undefined ? { sourcePage: Number(row.sourcePage) } : {}),
              ...(row.sourcePeriod !== undefined ? { sourcePeriod: String(row.sourcePeriod) } : {}),
            };
          }),
        }
      : {}),
    ...(rec.note !== undefined ? { note: String(rec.note) } : {}),
  };
  return declaration;
}
