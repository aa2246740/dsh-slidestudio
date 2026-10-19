import { t } from "./i18n.js";
import { THEMES, applyTheme, currentTheme } from "./theme.js";

export const FREESTYLE_STYLE = {
  id: "freestyle",
  title: "Freestyle",
  label: "自由风格",
  cat: "All",
  preview: "template-freestyle.jpg",
  previewUrl: "./templates/template-freestyle.jpg",
  system: "",
};

/** @param {string | null | undefined} path */
export function themeAssetUrl(path) {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("/slides/")) {
    return path;
  }
  const root = location.pathname.startsWith("/app/") ? "/app" : "";
  const clean = path.replace(/^\.\//, "").replace(/^\//, "");
  return `${root}/${clean}`;
}

/** @param {unknown} value */
export function toRgbColor(value) {
  const raw = String(value || "").trim();
  if (!raw || /gradient/i.test(raw)) return "rgb(232, 232, 234)";
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    let h = hex[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const n = parseInt(h, 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  if (/^rgba?\(/i.test(raw)) return raw;
  return raw;
}

export function paintThemeOptions() {
  const host = document.getElementById("theme-options");
  if (!host) return;
  const active = currentTheme();
  host.replaceChildren(
    ...THEMES.map((theme) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "theme-option";
      option.dataset.themeId = theme.id;
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(theme.id === active));
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      swatch.dataset.themeSwatch = theme.id;
      const name = document.createElement("b");
      name.textContent = t(theme.name);
      const note = document.createElement("small");
      note.textContent = t(theme.note);
      option.append(swatch, name, note);
      option.addEventListener("click", () => {
        applyTheme(theme.id);
        paintThemeOptions();
        const selected = /** @type {HTMLButtonElement | null} */ (
          document.querySelector(`[data-theme-id="${theme.id}"]`)
        );
        selected?.focus();
      });
      return option;
    }),
  );
}
