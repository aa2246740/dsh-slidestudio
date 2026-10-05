window.__ModuleLoader__.load({
	id: "dsh-slidestudio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		const name = "dsh-slidestudio-client";
		const inject = ["slots"];
		/** Use the Host's rendered settings control on Web and native Desktop alike.
		* Desktop ignores synthetic DOM shortcut events. RC2 exposes no public command
		* invocation API, so use its slot/ARIA controls without touching private stores.
		*/
		function activateSettingsControl(ctx) {
			const trigger = document.querySelector("[data-slot=\"sidebar.settings\"] [data-slot=\"settings.trigger\"]")?.closest("button");
			if (trigger && !trigger.disabled) {
				trigger.click();
				return true;
			}
			const launcher = document.querySelector("[data-slot=\"sidebar.settings\"] [data-slot=\"settings.launcher\"] button[aria-haspopup=\"menu\"]");
			if (!launcher || launcher.disabled) return false;
			if (launcher.getAttribute("aria-expanded") !== "true") {
				launcher.click();
				return false;
			}
			const aria = ctx.get("shortcuts")?.catalog.getSnapshot().find((row) => String(row.id) === "settings.open")?.aria;
			const matches = [...document.querySelectorAll("[role=\"menu\"] button[role=\"menuitem\"]")].filter((button) => {
				if (button.disabled) return false;
				if (aria && button.getAttribute("aria-keyshortcuts") === aria) return true;
				const label = button.cloneNode(true);
				label.querySelectorAll("[aria-hidden=\"true\"]").forEach((node) => node.remove());
				return ["设置", "Settings"].includes(label.textContent?.trim() ?? "");
			});
			if (matches.length !== 1) return false;
			matches[0].click();
			return true;
		}
		/** The hub inside the iframe follows DSH's own Language setting. */
		let currentLang = "zh";
		function activeLang(ctx) {
			try {
				return ctx.get("locale")?.getLocale?.().active === "en" ? "en" : "zh";
			} catch {
				return "zh";
			}
		}
		function slideTitle() {
			return currentLang === "en" ? "Slides" : "演示文稿";
		}
		function slideDescription() {
			return currentLang === "en" ? "Turn one sentence into a polished slide deck" : "一句话把想法变成漂亮的演示文稿";
		}
		/** Push the active locale into every app iframe the plugin mounted. */
		function broadcastLang() {
			for (const frame of document.querySelectorAll("iframe")) try {
				if (!new URL(frame.src, location.href).pathname.startsWith("/app/")) continue;
				frame.contentWindow?.postMessage({
					type: "oss:locale",
					lang: currentLang
				}, location.origin);
			} catch {}
		}
		function settingsModalOpen() {
			return document.querySelector("[data-shortcut-modal=\"settings\"]") !== null;
		}
		/** Any other dialog holding the modal layer — e.g. the settings.onboarding
		*  key prompt that re-mounts on a fresh home — blocks `settings.open`. */
		function otherDialogOpen() {
			return document.querySelector("[role=\"dialog\"][aria-modal=\"true\"]:not([data-shortcut-modal=\"settings\"])") !== null;
		}
		/** The slot renderer marks each mount site with `data-slot` — the anchor is
		*  absent on pages (like Personal's) that never render `sidebar.settings`. */
		function settingsUiMounted() {
			return document.querySelector("[data-slot=\"sidebar.settings\"]") !== null;
		}
		/**
		* Open the DSH settings panel. The settings modal renders inside the
		* `sidebar.settings` occupant, which Personal pages don't mount — dispatching
		* there would only leak a latent open flag into the shell store. When the
		* mount is absent, switch to the home panel (standard sidebar) first, then
		* drive the dialog open; when it closes, return to the originating panel —
		* unless the user navigated elsewhere in the meantime.
		*/
		function openDshSettings(ctx, source, origin) {
			const notify = (type) => {
				if (source && "postMessage" in source) source.postMessage({ type }, origin);
			};
			notify("oss:dsh-settings-accepted");
			const resumePersonal = ctx.get("personal")?.suspend?.();
			if (settingsUiMounted()) {
				driveSettingsOpen(ctx, resumePersonal ?? null, notify);
				return;
			}
			const layout = ctx.get("layout");
			if (!layout) {
				resumePersonal?.();
				notify("oss:dsh-settings-failed");
				return;
			}
			const previousPanel = layout.panelInfo?.getSnapshot().activePanelId ?? null;
			layout.selectPanel(null);
			const navigation = layout.beginNavigation?.() ?? null;
			driveSettingsOpen(ctx, () => {
				if (navigation?.aborted) {
					resumePersonal?.(false);
					return;
				}
				try {
					layout.selectPanel(previousPanel);
				} catch {}
				resumePersonal?.();
			}, notify);
		}
		/**
		* Drive the settings dialog through its real open/close lifecycle:
		* wait out whichever dialog owns the layer (the onboarding key prompt is
		* dismiss-ignored — it cannot and need not be closed by us), dispatch
		* `settings.open` once the layer is free, and finish when the dialog the
		* user finally sees closes. `finish` (restore) is only meaningful after a
		* navigation; in-place callers pass null.
		*/
		function driveSettingsOpen(ctx, finish, notify) {
			let finished = false;
			let opened = false;
			let needDispatch = true;
			let waited = 0;
			const done = () => {
				if (finished) return;
				finished = true;
				window.clearInterval(timer);
				window.clearTimeout(deadline);
				finish?.();
				if (!opened) notify("oss:dsh-settings-failed");
			};
			const timer = window.setInterval(() => {
				waited += 250;
				if (settingsModalOpen()) {
					if (!opened) notify("oss:dsh-settings-opened");
					opened = true;
					return;
				}
				if (opened) {
					done();
					return;
				}
				if (otherDialogOpen()) {
					needDispatch = true;
					waited = 0;
					return;
				}
				if (needDispatch && waited >= 400) needDispatch = !activateSettingsControl(ctx);
				if (waited >= 1e4) done();
			}, 250);
			const deadline = window.setTimeout(done, 6e5);
			ctx.effect(() => done);
		}
		let pageDestination;
		const pageListeners = /* @__PURE__ */ new Set();
		function SlidesPage() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
				title: "DSH SlideStudio",
				src: react.default.useSyncExternalStore((listener) => {
					pageListeners.add(listener);
					return () => {
						pageListeners.delete(listener);
					};
				}, () => pageDestination) ?? `/app/hub.html?lang=${currentLang}`,
				style: {
					display: "block",
					width: "100%",
					height: "100%",
					minHeight: "80vh",
					border: 0
				}
			});
		}
		function SlidesEntryIcon({ size = 16 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "1.5",
						y: "2.5",
						width: "13",
						height: "9",
						rx: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 11.5v2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 14h5" })
				]
			});
		}
		const PANEL = "slides";
		/** Public composer takeover: accidental Work entry remains readable, with no
		* prompt box that can bypass the editor's project/intent checks. */
		function registerSessionEntry(ctx) {
			ctx.inject(["sessions"], (inner) => {
				const sessions = inner.get("sessions");
				const ReadOnlyComposer = ({ matched }) => {
					const [busy, setBusy] = react.default.useState(false);
					const [error, setError] = react.default.useState("");
					const english = currentLang === "en";
					const open = async () => {
						setBusy(true);
						setError("");
						try {
							const response = await fetch(`/slides/state/${encodeURIComponent(matched)}`);
							const state = await response.json();
							if (!response.ok || !state.binding?.projectRoot) throw new Error(state.error || (english ? "Deck unavailable" : "找不到对应的演示文稿"));
							pageDestination = `/app/index.html?${new URLSearchParams({
								project: state.binding.projectRoot,
								session: matched,
								workspace: "1",
								live: "1",
								lang: currentLang
							})}`;
							pageListeners.forEach((listener) => listener());
							if (!ctx.get("personal")?.open?.(PANEL)) ctx.get("layout")?.selectPanel(PANEL);
						} catch (cause) {
							setError(cause instanceof Error ? cause.message : String(cause));
						} finally {
							setBusy(false);
						}
					};
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						"aria-label": english ? "SlideStudio generation history" : "演示文稿生成记录",
						style: {
							padding: "16px 20px",
							border: "1px solid var(--dsw-alias-border-l3, #ddd)",
							borderRadius: 12,
							background: "var(--dsw-alias-button-elevated-fill, #fff)",
							color: "var(--dsw-alias-label-primary, #222)"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: english ? "Continue editing in SlideStudio" : "请在演示文稿中继续编辑" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									margin: "8px 0 12px",
									fontSize: 13
								},
								children: english ? "This conversation is the generation history. Open the deck to edit, continue generation or stop it." : "这里保留生成记录。修改内容、继续生成或停止生成，请打开对应的演示文稿。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy,
								onClick: () => {
									open();
								},
								style: {
									font: "inherit",
									padding: "8px 14px",
									border: "1px solid var(--dsw-alias-border-l3, #ddd)",
									borderRadius: 8,
									background: "transparent",
									color: "inherit",
									cursor: "pointer"
								},
								children: busy ? english ? "Opening…" : "正在打开…" : english ? "Open in SlideStudio" : "在演示文稿中继续"
							}),
							error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								children: error
							})
						]
					});
				};
				inner.slots.inject("conversation.composer", () => {
					let remove;
					let signature = "";
					const update = () => {
						const owned = Object.entries(sessions.list.getSnapshot().byId).filter(([, row]) => row.projectionValues?.agentPreset === "slides").map(([id]) => id).sort();
						const next = JSON.stringify(owned);
						if (next === signature) return;
						signature = next;
						remove?.();
						const ids = new Set(owned);
						remove = inner.slots.register({
							name: "conversation.composer",
							priority: -100,
							select: (owner) => owner.sessionId && ids.has(owner.sessionId) ? owner.sessionId : null
						}, ReadOnlyComposer);
					};
					update();
					const off = sessions.list.subscribe(update);
					return () => {
						off();
						remove?.();
					};
				});
			});
		}
		/** Main panels must reserve the official desktop window-chrome strip. */
		function StandaloneSlidesPage() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					height: "100%",
					boxSizing: "border-box",
					paddingTop: "var(--dsh-frame-top-clearance, 0px)"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SlidesPage, {})
			});
		}
		/** Standalone mode: 演示文稿 sits in the official sidebar panel list itself. */
		function registerStandalone(ctx) {
			const stops = [ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL,
				order: -9,
				label: () => slideTitle()
			}, SlidesEntryIcon))];
			return () => {
				for (const stop of stops) stop();
			};
		}
		function apply(ctx) {
			currentLang = activeLang(ctx);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL
			}, StandaloneSlidesPage));
			registerSessionEntry(ctx);
			ctx.effect(() => {
				const onMessage = (event) => {
					if (event.origin !== location.origin || event.data?.type !== "oss:open-dsh-settings") return;
					openDshSettings(ctx, event.source, event.origin);
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			});
			ctx.effect(() => {
				const locale = ctx.get("locale");
				if (!locale) return () => {};
				return locale.subscribe(() => {
					const next = activeLang(ctx);
					if (next === currentLang) return;
					currentLang = next;
					broadcastLang();
				});
			});
			let standalone = registerStandalone(ctx);
			ctx.inject(["personal"], (inner) => {
				standalone?.();
				standalone = void 0;
				const registerFeature = () => inner.personal.register({
					id: "slides",
					title: slideTitle(),
					description: slideDescription(),
					order: 1,
					component: SlidesPage
				});
				let remove = registerFeature();
				const offLocale = ctx.get("locale")?.subscribe(() => {
					remove();
					remove = registerFeature();
				});
				return () => {
					offLocale?.();
					remove();
					try {
						standalone = registerStandalone(ctx);
					} catch {}
				};
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map