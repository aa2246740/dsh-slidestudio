/** Required static controls fail explicitly instead of relying on casts.
 * @template {HTMLElement} T
 * @param {string} id @param {new () => T} type @returns {T} */
export function hubElement(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Hub 控件缺失或类型错误：${id}`);
  return node;
}

/** @param {string} path */
export function nativeApi(path) {
  const rest = path.replace(/^\/api/, "");
  const root = location.pathname.startsWith("/app/") ? "/app/api" : "/api";
  return `${root}${rest.startsWith("/") ? rest : `/${rest}`}`;
}

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = new Map([
      ["&", "&amp;"],
      ["<", "&lt;"],
      [">", "&gt;"],
      ['"', "&quot;"],
      ["'", "&#39;"],
    ]);
    return entities.get(character) || character;
  });
}
