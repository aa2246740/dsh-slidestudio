/**
 * A single materialized file may not exceed this size: the largest per-type upload limit
 * (50 MiB for PPTX and PDF) plus the same 4 MiB of slack the derivative and normalized copy get.
 */
export const MATERIAL_MAX_ORIGINAL_BYTES = 54 * 1024 * 1024;

/**
 * Raw template-logo bytes. Separate from {@link MATERIAL_MAX_ORIGINAL_BYTES}:
 * a compressed PPTX can legally inflate a logo past the derivative cap.
 * Intake stores the first usable candidate within this cap and skips the rest;
 * materialization refuses a `<id>.logo` above it.
 */
export const MATERIAL_MAX_LOGO_BYTES = 24 * 1024 * 1024;
