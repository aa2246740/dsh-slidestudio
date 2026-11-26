import { TOOL_RUNTIME_I18N } from "./tool-runtime-i18n.js";
import { WORKSPACE_REVIEW_I18N } from "./workspace-review-i18n.js";
import { ATTACHMENTS_I18N } from "./attachments-i18n.js";
import { CANVAS_PAINT_I18N } from "./canvas-paint-i18n.js";
import { EDITOR_LEASE_I18N } from "./editor-lease-i18n.js";
import { EXPORT_I18N } from "./export-i18n.js";
import { LAYOUT_I18N } from "./layout-i18n.js";
import { LEGACY_OFFICE_I18N } from "./legacy-office-i18n.js";
import { REVIEW_LIFECYCLE_I18N } from "./review-lifecycle-i18n.js";

/**
 * English copy owned by feature modules. Each slice keys on the Chinese source
 * text; i18n.js spreads this merged table ahead of its own EN dictionary, so a
 * key defined there still wins.
 * @type {Record<string, string>}
 */
export const FEATURE_I18N = {
  ...TOOL_RUNTIME_I18N,
  ...WORKSPACE_REVIEW_I18N,
  ...ATTACHMENTS_I18N,
  ...CANVAS_PAINT_I18N,
  ...EDITOR_LEASE_I18N,
  ...EXPORT_I18N,
  ...LAYOUT_I18N,
  ...LEGACY_OFFICE_I18N,
  ...REVIEW_LIFECYCLE_I18N,
};
