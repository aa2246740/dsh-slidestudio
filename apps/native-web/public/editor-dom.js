/** @import {EditorElement} from "../types/app/editor-dom.js" */
/** Optional chrome lookup. The static IDs keep their native input/dialog/event types.
 * @template {string} Id @param {Id} id
 * @returns {EditorElement<Id> | null} */
export function editorElement(id) {
  return /** @type {EditorElement<Id> | null} */ (document.getElementById(id));
}

/** Only at sites that already required the node; never turn optional UI into required UI.
 * @template {string} Id @param {Id} id */
export function requireEditorElement(id) {
  const element = editorElement(id);
  if (!element) throw new Error(`Missing editor element: ${id}`);
  return element;
}
