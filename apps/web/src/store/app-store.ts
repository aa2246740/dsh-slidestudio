import { create } from "zustand";
import {
  applyCommand,
  deepClone,
  cmdAddElement,
  cmdUpdateElement,
  cmdUpdateChartData,
  cmdUpdateSmartArt,
  createId as pptdId,
  solidFill,
  PptdError,
  type ChartType,
  type ChartSeries,
  type Command,
  type Deck,
  type ElementPatch,
  type SlideElement,
  type SmartArtNode,
} from "@open-slidestudio/pptd";
import {
  createAgentRun,
  MockProvider,
  processPinBatch,
  type AgentReference,
  type AgentRun,
  type AgentRunStatus,
  type AgentStep,
} from "@open-slidestudio/agent-core";
import { generateDeckRemote } from "../lib/api";
import { DEFAULT_MODEL_ID } from "../lib/models";

/** Silent mock fallback on API failure is opt-in: VITE_ALLOW_MOCK_FALLBACK=1. */
const ALLOW_MOCK_FALLBACK = import.meta.env.VITE_ALLOW_MOCK_FALLBACK === "1";
import { DEFAULT_TEMPLATE_ID, type TemplateCategory } from "../lib/templates";

export type AppScreen = "create" | "agent" | "workspace";

export type LocalReference = AgentReference & {
  status: "queued" | "uploading" | "parsing" | "parsed" | "unsupported" | "failed";
  progress?: number;
  mimeType?: string;
  sizeBytes?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
};

export type DeckVersion = {
  id: string;
  versionId: string;
  versionNumber: number;
  versionLabel: string;
  label: string;
  createdAt: string;
  summary: string;
  deck: Deck;
  actor: "user" | "agent";
};

/** Agent annotation pin — work order for the agent (not a human discussion thread). */
export type CommentPin = {
  id: string;
  slideId: string;
  x: number;
  y: number;
  text: string;
  resolved: boolean;
  createdAt: string;
  number: number;
  /** Set when pin-batch failed this pin; remains open for retry */
  failReason?: string;
};

export type ToastState = {
  id: string;
  message: string;
  kind: "info" | "success" | "error";
} | null;

export type WorkspacePane = "chat" | "editor";

type HistoryEntry = {
  deck: Deck;
};

type AppState = {
  screen: AppScreen;
  prompt: string;
  templateId: string;
  templateCategory: TemplateCategory;
  modelId: string;
  references: LocalReference[];
  attachModalOpen: boolean;

  // Agent
  agentStatus: AgentRunStatus | "idle";
  agentSteps: AgentStep[];
  agentSummary: string;
  agentError: string | null;
  activeRun: AgentRun | null;
  expandedStepIds: Record<string, boolean>;

  // Deck / workspace
  deck: Deck | null;
  versions: DeckVersion[];
  activeVersionId: string | null;
  viewingVersionId: string | null;
  currentSlideId: string | null;
  selectedElementId: string | null;
  thumbsOpen: boolean;
  zoom: number;
  fitZoom: boolean;
  comments: CommentPin[];
  commentMode: boolean;
  draftComment: { slideId: string; x: number; y: number } | null;
  chatMessages: ChatMessage[];
  refineDraft: string;
  refining: boolean;
  exportModalOpen: boolean;
  exporting: boolean;
  toast: ToastState;
  workspacePane: WorkspacePane;
  versionMenuOpen: boolean;
  playMode: boolean;

  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  // Actions
  setPrompt: (v: string) => void;
  setTemplateId: (id: string) => void;
  setTemplateCategory: (c: TemplateCategory) => void;
  setModelId: (id: string) => void;
  setAttachModalOpen: (open: boolean) => void;
  addDemoReference: (file?: {
    name: string;
    mimeType?: string;
    text?: string;
    sizeBytes?: number;
    dataUrl?: string;
    kind?: "file" | "image";
  }) => void;
  removeReference: (id: string) => void;
  updateReference: (id: string, patch: Partial<LocalReference>) => void;
  setScreen: (s: AppScreen) => void;
  toggleStepExpanded: (id: string) => void;
  startGenerate: () => void;
  cancelRun: () => void;
  openWorkspace: () => void;
  backToCreate: () => void;
  selectSlide: (id: string) => void;
  selectElement: (id: string | null) => void;
  setThumbsOpen: (v: boolean) => void;
  setZoom: (z: number) => void;
  setFitZoom: (v: boolean) => void;
  setCommentMode: (v: boolean) => void;
  placeCommentDraft: (slideId: string, x: number, y: number) => void;
  submitComment: (text: string) => void;
  cancelCommentDraft: () => void;
  resolveComment: (id: string) => void;
  /** Process all open agent annotation pins in one agent batch */
  processAllAnnotations: () => void;
  processingPins: boolean;
  setRefineDraft: (v: string) => void;
  sendRefinement: () => void;
  setExportModalOpen: (v: boolean) => void;
  setExporting: (v: boolean) => void;
  showToast: (message: string, kind?: "info" | "success" | "error") => void;
  clearToast: () => void;
  setWorkspacePane: (p: WorkspacePane) => void;
  setVersionMenuOpen: (v: boolean) => void;
  viewVersion: (versionId: string) => void;
  restoreVersion: (versionId: string) => void;
  backToLatestVersion: () => void;
  setPlayMode: (v: boolean) => void;
  applyLocalCommand: (cmd: Command) => void;
  updateSelectedText: (text: string) => void;
  nudgeSelected: (dx: number, dy: number) => void;
  addTextBox: () => void;
  addShape: () => void;
  addTable: () => void;
  addChart: () => void;
  addImage: (src: string, name?: string) => void;
  addSmartArt: () => void;
  updateSelectedChart: (data: {
    categories?: string[];
    series?: ChartSeries[];
    chartType?: ChartType;
  }) => void;
  updateSelectedSmartArtNodes: (nodes: SmartArtNode[]) => void;
  chartDataEditorOpen: boolean;
  setChartDataEditorOpen: (v: boolean) => void;
  shareModalOpen: boolean;
  setShareModalOpen: (v: boolean) => void;
  undo: () => void;
  redo: () => void;
  pushVersionSnapshot: (opts: {
    deck: Deck;
    versionId: string;
    versionNumber: number;
    versionLabel: string;
    summary: string;
    actor: "user" | "agent";
  }) => void;
};

let refSeq = 0;
const msgSeq = 0;
let commentSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useAppStore = create<AppState>((set, get) => ({
  screen: "create",
  prompt: "",
  templateId: DEFAULT_TEMPLATE_ID,
  templateCategory: "all",
  modelId: DEFAULT_MODEL_ID,
  references: [],
  attachModalOpen: false,

  agentStatus: "idle",
  agentSteps: [],
  agentSummary: "",
  agentError: null,
  activeRun: null,
  expandedStepIds: {},

  deck: null,
  versions: [],
  activeVersionId: null,
  viewingVersionId: null,
  currentSlideId: null,
  selectedElementId: null,
  thumbsOpen: true,
  zoom: 0.45,
  fitZoom: true,
  comments: [],
  commentMode: false,
  draftComment: null,
  processingPins: false,
  chatMessages: [],
  refineDraft: "",
  refining: false,
  exportModalOpen: false,
  exporting: false,
  chartDataEditorOpen: false,
  shareModalOpen: false,
  toast: null,
  workspacePane: "editor",
  versionMenuOpen: false,
  playMode: false,

  undoStack: [],
  redoStack: [],

  setPrompt: (v) => set({ prompt: v }),
  setTemplateId: (templateId) => set({ templateId }),
  setTemplateCategory: (templateCategory) => set({ templateCategory }),
  setModelId: (modelId) => set({ modelId }),
  setAttachModalOpen: (attachModalOpen) => set({ attachModalOpen }),

  addDemoReference: (file) => {
    const n = ++refSeq;
    const isImage =
      file?.kind === "image" ||
      Boolean(file?.mimeType?.startsWith("image/")) ||
      Boolean(file?.name && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
    const ref: LocalReference = {
      id: id("ref"),
      name: file?.name ?? `brief-notes-${n}.txt`,
      mimeType: file?.mimeType ?? (isImage ? "image/png" : "text/plain"),
      text:
        file?.text ??
        (isImage
          ? "Sense\nRoute\nDecide\nAct\nLearn\nSMART CONNECTIONS infographic stages"
          : "Sample reference: market size, competitive landscape, and three strategic recommendations for the briefing."),
      sizeBytes: file?.sizeBytes ?? 4_200,
      dataUrl: file?.dataUrl,
      kind: isImage ? "image" : file?.kind ?? "file",
      status: "uploading",
      progress: 0,
    };
    set((s) => ({ references: [...s.references, ref] }));

    // Simulate upload → parse for demo UX
    let progress = 0;
    const tick = window.setInterval(() => {
      progress = Math.min(100, progress + 18 + Math.random() * 20);
      const status: LocalReference["status"] =
        progress >= 100 ? "parsing" : "uploading";
      get().updateReference(ref.id, {
        progress: Math.min(100, Math.round(progress)),
        status,
      });
      if (progress >= 100) {
        window.clearInterval(tick);
        window.setTimeout(() => {
          get().updateReference(ref.id, {
            status: "parsed",
            progress: 100,
          });
        }, 450);
      }
    }, 160);
  },

  removeReference: (refId) =>
    set((s) => ({ references: s.references.filter((r) => r.id !== refId) })),

  updateReference: (refId, patch) =>
    set((s) => ({
      references: s.references.map((r) =>
        r.id === refId ? { ...r, ...patch } : r,
      ),
    })),

  setScreen: (screen) => set({ screen }),
  toggleStepExpanded: (stepId) =>
    set((s) => ({
      expandedStepIds: {
        ...s.expandedStepIds,
        [stepId]: !s.expandedStepIds[stepId],
      },
    })),

  startGenerate: () => {
    const state = get();
    const prompt = state.prompt.trim();
    if (!prompt && state.references.length === 0) return;

    state.activeRun?.cancel();

    const agentRefs: AgentReference[] = state.references
      .filter((r) => r.status === "parsed" || r.status === "uploading" || r.status === "parsing")
      .map((r) => ({
        id: r.id,
        name: r.name,
        mimeType: r.mimeType,
        text: r.text,
        sizeBytes: r.sizeBytes,
        dataUrl: r.dataUrl,
        kind: r.kind,
      }));

    const userMsg: ChatMessage = {
      id: id("msg"),
      role: "user",
      content: prompt || "(Attached references only)",
      at: nowIso(),
    };

    set({
      screen: "agent",
      agentStatus: "planning",
      agentSteps: [
        {
          id: id("step"),
          tool: "think",
          label: "Think",
          status: "running",
          startedAt: nowIso(),
        },
      ],
      agentSummary: "",
      agentError: null,
      expandedStepIds: {},
      deck: null,
      versions: [],
      activeVersionId: null,
      viewingVersionId: null,
      currentSlideId: null,
      selectedElementId: null,
      comments: [],
      chatMessages: [userMsg],
      undoStack: [],
      redoStack: [],
      activeRun: null,
    });

    // Prefer real LLM via local API server; an in-browser mock on API failure
    // is opt-in only (VITE_ALLOW_MOCK_FALLBACK=1) — a real-model request must
    // never silently produce a mock deck.
    void (async () => {
      try {
        set({ agentStatus: "composing" });
        const result = await generateDeckRemote({
          prompt: prompt || "Build a research briefing from the attached references.",
          templateId: state.templateId,
          modelId: state.modelId,
          references: agentRefs,
        });

        const deck = deepClone(result.deck);
        const first = [...deck.slides].sort((a, b) => a.order - b.order)[0];
        get().pushVersionSnapshot({
          deck,
          versionId: result.versionId,
          versionNumber: result.versionNumber,
          versionLabel: result.versionLabel,
          summary: result.summary || "Initial generation",
          actor: "agent",
        });

        const steps: AgentStep[] =
          result.steps?.length > 0
            ? result.steps.map((s) => ({ ...s, status: s.status || "completed" }))
            : [
                {
                  id: id("step"),
                  tool: "compose_deck",
                  label: "Compose deck",
                  status: "completed",
                  summary: `${deck.slides.length} slides via ${result.displayName || result.provider}`,
                },
              ];

        set({
          agentStatus: "ready",
          agentSteps: steps,
          agentSummary: result.summary,
          deck,
          currentSlideId: first?.id ?? null,
          activeVersionId: result.versionId,
          viewingVersionId: null,
          chatMessages: [
            ...get().chatMessages,
            {
              id: id("msg"),
              role: "assistant",
              content: result.summary,
              at: nowIso(),
            },
          ],
          screen: "workspace",
          workspacePane: "editor",
        });
        get().showToast(
          `Generated with ${result.displayName || result.provider}`,
          "success",
        );
      } catch (err) {
        // Fallback: offline mock in the browser if API is down
        const message = err instanceof Error ? err.message : String(err);
        if (
          state.modelId === "mock-offline" ||
          (ALLOW_MOCK_FALLBACK && /Failed to fetch|ECONNREFUSED|404|health/i.test(message))
        ) {
          try {
            const run = createAgentRun(
              {
                prompt:
                  prompt || "Build a research briefing from the attached references.",
                templateId: state.templateId,
                modelId: "mock-offline",
                references: agentRefs,
                mockSpeed: 0.5,
              },
              {
                autoStart: true,
                provider: new MockProvider({ baseDelayMs: 60 }),
              },
            );
            set({ activeRun: run, agentStatus: "composing", agentError: null });
            const unsub = run.subscribe((event) => {
              if (event.type === "tool_started") {
                set((s) => ({
                  agentSteps: [
                    ...s.agentSteps.filter((st) => st.status === "completed"),
                    {
                      id: event.stepId,
                      tool: event.tool,
                      label: event.label,
                      target: event.target,
                      status: "running",
                      startedAt: event.at,
                    },
                  ],
                }));
              } else if (event.type === "tool_completed") {
                set((s) => ({
                  agentSteps: s.agentSteps.map((st) =>
                    st.id === event.stepId
                      ? {
                          ...st,
                          status: "completed",
                          summary: event.summary,
                          durationMs: event.durationMs,
                        }
                      : st,
                  ),
                }));
              } else if (event.type === "deck_ready") {
                const deck = deepClone(event.deck);
                const first = [...deck.slides].sort((a, b) => a.order - b.order)[0];
                get().pushVersionSnapshot({
                  deck,
                  versionId: event.versionId,
                  versionNumber: event.versionNumber,
                  versionLabel: event.versionLabel,
                  summary: "Mock generation",
                  actor: "agent",
                });
                set({
                  deck,
                  currentSlideId: first?.id ?? null,
                  activeVersionId: event.versionId,
                });
              }
            });
            await run.wait();
            unsub();
            set({
              agentStatus: "ready",
              screen: "workspace",
              workspacePane: "editor",
            });
            get().showToast("API offline — used Mock Offline", "info");
            return;
          } catch (mockErr) {
            const m =
              mockErr instanceof Error ? mockErr.message : String(mockErr);
            set({ agentStatus: "failed", agentError: m });
            return;
          }
        }
        set({ agentStatus: "failed", agentError: message });
      }
    })();
  },

  cancelRun: () => {
    get().activeRun?.cancel();
    set({ agentStatus: "cancelled" });
  },

  openWorkspace: () => {
    const { deck } = get();
    if (!deck) return;
    set({ screen: "workspace", workspacePane: "editor" });
  },

  backToCreate: () => {
    get().activeRun?.cancel();
    set({
      screen: "create",
      agentStatus: "idle",
      activeRun: null,
      playMode: false,
    });
  },

  selectSlide: (currentSlideId) =>
    set({ currentSlideId, selectedElementId: null, draftComment: null }),

  selectElement: (selectedElementId) =>
    set((s) => {
      const el = selectedElementId
        ? s.deck?.slides
            .flatMap((sl) => sl.elements)
            .find((e) => e.id === selectedElementId)
        : undefined;
      return {
        selectedElementId,
        // open data editor when a chart is selected (PRD frame 12–13)
        chartDataEditorOpen: el?.kind === "chart",
      };
    }),

  setThumbsOpen: (thumbsOpen) => set({ thumbsOpen }),
  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)), fitZoom: false }),
  setFitZoom: (fitZoom) => set({ fitZoom }),
  setCommentMode: (commentMode) =>
    set({ commentMode, draftComment: commentMode ? get().draftComment : null }),

  placeCommentDraft: (slideId, x, y) =>
    set({ draftComment: { slideId, x, y }, commentMode: true }),

  submitComment: (text) => {
    const draft = get().draftComment;
    if (!draft || !text.trim()) return;
    const number = ++commentSeq;
    const pin: CommentPin = {
      id: id("cmt"),
      slideId: draft.slideId,
      x: draft.x,
      y: draft.y,
      text: text.trim(),
      resolved: false,
      createdAt: nowIso(),
      number,
    };
    set((s) => ({
      comments: [...s.comments, pin],
      draftComment: null,
      commentMode: false,
    }));
    get().showToast(`Agent pin #${number} added — process when ready`, "success");
  },

  cancelCommentDraft: () => set({ draftComment: null }),

  resolveComment: (commentId) =>
    set((s) => ({
      comments: s.comments.map((c) =>
        c.id === commentId ? { ...c, resolved: true } : c,
      ),
    })),

  processAllAnnotations: () => {
    const state = get();
    const open = state.comments.filter((c) => !c.resolved);
    const baseDeck = state.deck;
    if (!open.length || !baseDeck || state.processingPins || state.viewingVersionId) {
      if (!open.length) get().showToast("No open annotations", "info");
      return;
    }

    const pins = open.map((c) => ({
      id: c.id,
      slideId: c.slideId,
      x: c.x,
      y: c.y,
      text: c.text,
    }));

    set({
      processingPins: true,
      refining: true,
      agentStatus: "composing",
      workspacePane: "chat",
      chatMessages: [
        ...state.chatMessages,
        {
          id: id("msg"),
          role: "user",
          content: `Process ${open.length} agent annotation(s)`,
          at: nowIso(),
        },
      ],
    });

    const latest = state.versions[state.versions.length - 1];
    const preferMock =
      state.modelId === "mock-offline" || state.modelId === "mock";

    void (async () => {
      try {
        let result: Awaited<ReturnType<typeof generateDeckRemote>>;
        let usedFallback = false;

        if (preferMock) {
          const local = await processPinBatch(
            {
              deck: baseDeck,
              versionNumber: latest?.versionNumber ?? 1,
              versionId: latest?.versionId ?? baseDeck.versionId,
            },
            pins,
            { provider: new MockProvider({ baseDelayMs: 0 }), mockSpeed: 0 },
          );
          result = {
            deck: local.deck,
            versionId: local.versionId,
            versionNumber: local.versionNumber,
            versionLabel: local.versionLabel,
            summary: local.summary,
            steps: local.steps,
            pinBatch: local.pinBatch,
            provider: "mock",
            displayName: "Mock Provider",
          };
        } else {
          try {
            result = await generateDeckRemote({
              prompt: `Process ${open.length} agent annotation(s)`,
              title: baseDeck.title,
              templateId: state.templateId,
              modelId: state.modelId,
              baseDeck,
              baseVersionNumber: latest?.versionNumber ?? 1,
              baseVersionId: latest?.versionId ?? baseDeck.versionId,
              pins,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Only network/API-down may fall back, and only when explicitly
            // enabled — never silent mock on live model errors.
            if (!ALLOW_MOCK_FALLBACK || !/Failed to fetch|ECONNREFUSED|NetworkError|load failed|404|502|503/i.test(message)) {
              throw err;
            }
            usedFallback = true;
            const local = await processPinBatch(
              {
                deck: baseDeck,
                versionNumber: latest?.versionNumber ?? 1,
                versionId: latest?.versionId ?? baseDeck.versionId,
              },
              pins,
              { provider: new MockProvider({ baseDelayMs: 0 }), mockSpeed: 0 },
            );
            result = {
              deck: local.deck,
              versionId: local.versionId,
              versionNumber: local.versionNumber,
              versionLabel: local.versionLabel,
              summary: `${local.summary} (offline mock — API unavailable)`,
              steps: local.steps,
              pinBatch: local.pinBatch,
              provider: "mock",
              displayName: "Mock Provider (fallback)",
            };
          }
        }

        if (!result.pinBatch) {
          throw new Error(
            "Provider returned no pinBatch outcome — refusing to clear annotations",
          );
        }

        const ok = new Set(result.pinBatch.succeededPinIds);
        const failMap = new Map(
          result.pinBatch.failedPins.map((f) => [f.id, f.reason]),
        );
        const okN = result.pinBatch.succeededPinIds.length;
        const failN = result.pinBatch.failedPins.length;
        const versionBumped = okN > 0;

        const deck = deepClone(result.deck);
        if (versionBumped) {
          get().pushVersionSnapshot({
            deck,
            versionId: result.versionId,
            versionNumber: result.versionNumber,
            versionLabel: result.versionLabel,
            summary: result.summary || "Pin batch applied",
            actor: "agent",
          });
        }

        set((s) => ({
          deck: versionBumped ? deck : s.deck,
          activeVersionId: versionBumped
            ? result.versionId
            : s.activeVersionId,
          viewingVersionId: null,
          processingPins: false,
          refining: false,
          agentStatus: versionBumped || failN === 0 ? "ready" : "ready",
          // Keep resolved pins in history (do not drop them)
          comments: s.comments.map((c) => {
            if (ok.has(c.id)) {
              return { ...c, resolved: true, failReason: undefined };
            }
            if (failMap.has(c.id)) {
              return {
                ...c,
                resolved: false,
                failReason: failMap.get(c.id),
              };
            }
            return c;
          }),
          undoStack: versionBumped ? [] : s.undoStack,
          redoStack: versionBumped ? [] : s.redoStack,
          chatMessages: [
            ...s.chatMessages,
            {
              id: id("msg"),
              role: "assistant",
              content: usedFallback
                ? `${result.summary}\n(Used offline mock because the API was unreachable.)`
                : result.summary,
              at: nowIso(),
            },
          ],
        }));

        if (okN === 0) {
          get().showToast(
            `No annotations applied (${failN} failed) — version unchanged`,
            "error",
          );
        } else if (failN) {
          get().showToast(
            `Annotations: ${okN} applied, ${failN} need retry → ${result.versionLabel}`,
            "error",
          );
        } else {
          get().showToast(
            `Processed ${okN} annotation(s) → ${result.versionLabel}`,
            "success",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ processingPins: false, refining: false, agentStatus: "failed" });
        get().showToast(message || "Pin batch failed", "error");
      }
    })();
  },

  setRefineDraft: (refineDraft) => set({ refineDraft }),

  sendRefinement: () => {
    const state = get();
    const instruction = state.refineDraft.trim();
    const baseDeck = state.deck;
    if (!instruction || !baseDeck || state.refining) return;

    const userMsg: ChatMessage = {
      id: id("msg"),
      role: "user",
      content: instruction,
      at: nowIso(),
    };

    set({
      refineDraft: "",
      refining: true,
      agentStatus: "composing",
      agentSteps: [
        {
          id: id("step"),
          tool: "edit_slide",
          label: "Edit slide",
          status: "running",
          startedAt: nowIso(),
        },
      ],
      agentError: null,
      chatMessages: [...state.chatMessages, userMsg],
      screen: "workspace",
      workspacePane: "chat",
    });

    const latest = state.versions[state.versions.length - 1];
    void (async () => {
      try {
        const result = await generateDeckRemote({
          prompt: instruction,
          title: baseDeck.title,
          templateId: state.templateId,
          modelId: state.modelId,
          baseDeck,
          baseVersionNumber: latest?.versionNumber ?? 1,
          baseVersionId: latest?.versionId ?? baseDeck.versionId,
        });
        const deck = deepClone(result.deck);
        const keepSlide =
          deck.slides.find((s) => s.id === get().currentSlideId) ??
          [...deck.slides].sort((a, b) => a.order - b.order)[0];
        get().pushVersionSnapshot({
          deck,
          versionId: result.versionId,
          versionNumber: result.versionNumber,
          versionLabel: result.versionLabel,
          summary: instruction.slice(0, 120),
          actor: "agent",
        });
        set({
          refining: false,
          agentStatus: "ready",
          agentSteps: result.steps?.length
            ? result.steps
            : [
                {
                  id: id("step"),
                  tool: "edit_slide",
                  label: "Edit slide",
                  status: "completed",
                  summary: result.summary,
                },
              ],
          deck,
          currentSlideId: keepSlide?.id ?? null,
          activeVersionId: result.versionId,
          viewingVersionId: null,
          chatMessages: [
            ...get().chatMessages,
            {
              id: id("msg"),
              role: "assistant",
              content: result.summary,
              at: nowIso(),
            },
          ],
        });
        get().showToast(`Updated ${result.versionLabel}`, "success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ refining: false, agentStatus: "failed", agentError: message });
        get().showToast(message, "error");
      }
    })();
  },

  setExportModalOpen: (exportModalOpen) => set({ exportModalOpen }),
  setExporting: (exporting) => set({ exporting }),
  setChartDataEditorOpen: (chartDataEditorOpen) => set({ chartDataEditorOpen }),
  setShareModalOpen: (shareModalOpen) => set({ shareModalOpen }),

  showToast: (message, kind = "info") => {
    if (toastTimer) window.clearTimeout(toastTimer);
    const t = { id: id("toast"), message, kind };
    set({ toast: t });
    toastTimer = window.setTimeout(() => {
      set((s) => (s.toast?.id === t.id ? { toast: null } : s));
    }, 2400);
  },

  clearToast: () => set({ toast: null }),

  setWorkspacePane: (workspacePane) => set({ workspacePane }),
  setVersionMenuOpen: (versionMenuOpen) => set({ versionMenuOpen }),

  viewVersion: (versionId) => {
    const v = get().versions.find((x) => x.versionId === versionId);
    if (!v) return;
    const first = [...v.deck.slides].sort((a, b) => a.order - b.order)[0];
    set({
      viewingVersionId: versionId,
      deck: deepClone(v.deck),
      currentSlideId: first?.id ?? null,
      selectedElementId: null,
      versionMenuOpen: false,
    });
  },

  restoreVersion: (versionId) => {
    const v = get().versions.find((x) => x.versionId === versionId);
    if (!v) return;
    const latestNum =
      get().versions.reduce((m, x) => Math.max(m, x.versionNumber), 0) + 1;
    const versionLabel = `V${latestNum}`;
    const versionIdNew = id("ver");
    const deck = deepClone(v.deck);
    deck.versionId = versionIdNew;
    deck.updatedAt = nowIso();
    deck.meta = {
      ...(deck.meta ?? {}),
      versionNumber: String(latestNum),
      versionLabel,
      restoredFrom: versionId,
    };
    get().pushVersionSnapshot({
      deck,
      versionId: versionIdNew,
      versionNumber: latestNum,
      versionLabel,
      summary: `Restored from ${v.versionLabel}`,
      actor: "user",
    });
    const first = [...deck.slides].sort((a, b) => a.order - b.order)[0];
    set({
      deck,
      viewingVersionId: null,
      activeVersionId: versionIdNew,
      currentSlideId: first?.id ?? null,
      selectedElementId: null,
      versionMenuOpen: false,
      undoStack: [],
      redoStack: [],
    });
    get().showToast(`Restored as ${versionLabel}`, "success");
  },

  backToLatestVersion: () => {
    const versions = get().versions;
    const latest = versions[versions.length - 1];
    if (!latest) return;
    const first = [...latest.deck.slides].sort((a, b) => a.order - b.order)[0];
    set({
      viewingVersionId: null,
      deck: deepClone(latest.deck),
      activeVersionId: latest.versionId,
      currentSlideId: first?.id ?? null,
      selectedElementId: null,
    });
  },

  setPlayMode: (playMode) => set({ playMode, selectedElementId: null, commentMode: false }),

  applyLocalCommand: (cmd) => {
    const state = get();
    if (!state.deck || state.viewingVersionId) return;
    const prev = deepClone(state.deck);
    try {
      const result = applyCommand(state.deck, cmd);
      set({
        deck: result.deck,
        undoStack: [...state.undoStack, { deck: prev }].slice(-50),
        redoStack: [],
      });
    } catch (err) {
      const message =
        err instanceof PptdError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Edit failed";
      get().showToast(message, "error");
    }
  },

  updateSelectedText: (text) => {
    const state = get();
    const deck = state.deck;
    const slideId = state.currentSlideId;
    const elId = state.selectedElementId;
    if (!deck || !slideId || !elId) return;
    const slide = deck.slides.find((s) => s.id === slideId);
    const el = slide?.elements.find((e) => e.id === elId);
    if (!el || el.kind !== "text") return;
    const paragraphs = el.paragraphs.map((p, i) =>
      i === 0
        ? {
            ...p,
            runs: [{ ...(p.runs[0] ?? { text: "" }), text }],
          }
        : p,
    );
    const patch: ElementPatch = { paragraphs };
    get().applyLocalCommand(cmdUpdateElement(slideId, elId, patch));
  },

  /** Keyboard nudge for selected element (arrow keys; Shift = 10px). */
  nudgeSelected: (dx, dy) => {
    const state = get();
    const deck = state.deck;
    const slideId = state.currentSlideId;
    const elId = state.selectedElementId;
    if (!deck || !slideId || !elId || state.viewingVersionId) return;
    const slide = deck.slides.find((s) => s.id === slideId);
    const el = slide?.elements.find((e) => e.id === elId);
    if (!el || el.locked) return;
    get().applyLocalCommand(
      cmdUpdateElement(slideId, elId, {
        x: el.x + dx,
        y: el.y + dy,
      }),
    );
  },

  addTextBox: () => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const el: SlideElement = {
      kind: "text",
      id: pptdId("el"),
      x: 200,
      y: 280,
      width: 720,
      height: 120,
      rotation: 0,
      opacity: 1,
      zIndex: 50,
      name: "Text",
      paragraphs: [
        {
          runs: [
            {
              text: "New text",
              fontSize: 28,
              fontWeight: 500,
              color: state.deck.theme.colors.ink,
            },
          ],
        },
      ],
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false });
    get().showToast("Text box added", "success");
  },

  addShape: () => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const el: SlideElement = {
      kind: "shape",
      id: pptdId("el"),
      x: 320,
      y: 300,
      width: 480,
      height: 280,
      rotation: 0,
      opacity: 1,
      zIndex: 40,
      name: "Shape",
      shape: "roundRect",
      fill: solidFill(state.deck.theme.colors.accent || "#4D9CFF"),
      cornerRadius: 16,
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false });
    get().showToast("Shape added", "success");
  },

  addTable: () => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const ink = state.deck.theme.colors.ink;
    const el: SlideElement = {
      kind: "table",
      id: pptdId("el"),
      x: 160,
      y: 240,
      width: 1600,
      height: 360,
      rotation: 0,
      opacity: 1,
      zIndex: 45,
      name: "Table",
      rows: 3,
      cols: 3,
      columnWidths: [533, 533, 534],
      cells: [
        [
          { text: "A", fontWeight: 700, fill: solidFill("#EEF4FC"), color: ink, align: "center" },
          { text: "B", fontWeight: 700, fill: solidFill("#EEF4FC"), color: ink, align: "center" },
          { text: "C", fontWeight: 700, fill: solidFill("#EEF4FC"), color: ink, align: "center" },
        ],
        [
          { text: "—", color: ink, align: "center" },
          { text: "—", color: ink, align: "center" },
          { text: "—", color: ink, align: "center" },
        ],
        [
          { text: "—", color: ink, align: "center" },
          { text: "—", color: ink, align: "center" },
          { text: "—", color: ink, align: "center" },
        ],
      ],
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false });
    get().showToast("Table added", "success");
  },

  addChart: () => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const accent = state.deck.theme.colors.accent || "#4D9CFF";
    const el: SlideElement = {
      kind: "chart",
      id: pptdId("el"),
      x: 200,
      y: 220,
      width: 1520,
      height: 640,
      rotation: 0,
      opacity: 1,
      zIndex: 45,
      name: "Chart",
      chartType: "column",
      categories: ["A", "B", "C", "D"],
      series: [{ name: "Series", values: [12, 18, 9, 15], color: accent }],
      showLegend: true,
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false, chartDataEditorOpen: false });
    get().showToast("Chart added", "success");
  },

  addImage: (src, name) => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const el: SlideElement = {
      kind: "image",
      id: pptdId("el"),
      x: 240,
      y: 200,
      width: 960,
      height: 540,
      rotation: 0,
      opacity: 1,
      zIndex: 40,
      name: name || "Image",
      src,
      objectFit: "contain",
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false });
    get().showToast("Image added", "success");
  },

  addSmartArt: () => {
    const state = get();
    const slideId = state.currentSlideId;
    if (state.viewingVersionId) {
      get().showToast("Read-only history — return to latest to edit", "error");
      return;
    }
    if (!state.deck || !slideId) {
      get().showToast("No slide selected", "error");
      return;
    }
    const nodes: SmartArtNode[] = [
      { id: "n1", text: "Diagnose" },
      { id: "n2", text: "Prioritize", parentId: "n1" },
      { id: "n3", text: "Pilot", parentId: "n2" },
      { id: "n4", text: "Scale", parentId: "n3" },
    ];
    const el: SlideElement = {
      kind: "smartart",
      id: pptdId("el"),
      x: 120,
      y: 260,
      width: 1680,
      height: 400,
      rotation: 0,
      opacity: 1,
      zIndex: 45,
      name: "Process",
      layout: "process",
      nodes,
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
        { id: "e3", from: "n3", to: "n4" },
      ],
    };
    get().applyLocalCommand(cmdAddElement(slideId, el));
    set({ selectedElementId: el.id, commentMode: false });
    get().showToast("SmartArt process added", "success");
  },

  updateSelectedChart: (data) => {
    const state = get();
    const slideId = state.currentSlideId;
    const elId = state.selectedElementId;
    if (!state.deck || !slideId || !elId || state.viewingVersionId) return;
    const slide = state.deck.slides.find((s) => s.id === slideId);
    const el = slide?.elements.find((e) => e.id === elId);
    if (!el || el.kind !== "chart") return;
    get().applyLocalCommand(cmdUpdateChartData(slideId, elId, data));
  },

  updateSelectedSmartArtNodes: (nodes) => {
    const state = get();
    const slideId = state.currentSlideId;
    const elId = state.selectedElementId;
    if (!state.deck || !slideId || !elId || state.viewingVersionId) return;
    const slide = state.deck.slides.find((s) => s.id === slideId);
    const el = slide?.elements.find((e) => e.id === elId);
    if (!el || el.kind !== "smartart") return;
    get().applyLocalCommand(cmdUpdateSmartArt(slideId, elId, { nodes }));
  },

  undo: () => {
    const state = get();
    const prev = state.undoStack[state.undoStack.length - 1];
    if (!prev || !state.deck) return;
    set({
      deck: prev.deck,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, { deck: deepClone(state.deck) }],
      selectedElementId: null,
    });
  },

  redo: () => {
    const state = get();
    const next = state.redoStack[state.redoStack.length - 1];
    if (!next || !state.deck) return;
    set({
      deck: next.deck,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, { deck: deepClone(state.deck) }],
      selectedElementId: null,
    });
  },

  pushVersionSnapshot: ({
    deck,
    versionId,
    versionNumber,
    versionLabel,
    summary,
    actor,
  }) => {
    const entry: DeckVersion = {
      id: id("vsnap"),
      versionId,
      versionNumber,
      versionLabel,
      label: versionLabel,
      createdAt: nowIso(),
      summary,
      deck: deepClone(deck),
      actor,
    };
    set((s) => ({
      versions: [...s.versions.filter((v) => v.versionId !== versionId), entry],
      activeVersionId: versionId,
    }));
  },
}));

export function canGenerate(state: Pick<AppState, "prompt" | "references">): boolean {
  return state.prompt.trim().length > 0 || state.references.some((r) => r.status === "parsed");
}
