import type { AssistantQuestions } from "./assistant-questions.js";
import { type AssistantIntent, type AssistantIntentInput } from "./assistant-intent.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type PresentationRun } from "@open-slidestudio/presentation-run";
import { SliceSessionStore } from "./slice-session.js";
import { type SlidesLlmModel } from "./args.js";
import { type RuntimeModelCatalog } from "./local-models.js";
import { type EditorAttachment } from "./generation-input.js";
export type { EditorAttachment } from "./generation-input.js";
export type SlidesHostRuntime = {
    questions?: AssistantQuestions;
    store: SliceSessionStore;
    workspaceRoot: string;
    dataRoot?: string;
    dshHome: string;
    presentation: PresentationRun;
    agentBusy: (sessionId: string) => boolean;
    markBusy: (sessionId: string) => void;
    cancelRateLimitWait: (sessionId: string) => void;
    operatorStop: (sessionId: string) => Promise<void>;
    getAgent(sessionId: string): Agent | undefined;
    /** Awaits any in-flight re-archive, then unarchives a legacy session. */
    ensureSessionRunnable?(sessionId: string): Promise<void>;
    resolveAssistantIntent?: (input: AssistantIntentInput) => Promise<AssistantIntent>;
    /**
     * Last observed call outcome per provider, fed by the intent/turn path.
     * Credentials alone do not prove a route works: a signed-in oauth route
     * whose adapter is not mounted in this kernel, or a gateway whose upstream
     * is down, only reveals itself on a real call. The roster merges this so a
     * dead route stops presenting as ready after its first failure instead of
     * crashing every turn it is picked for.
     */
    providerHealth?: (provider: string) => {
        readonly kind: "broken" | "degraded";
        readonly reason: string;
    } | undefined;
    /**
     * Live adapter metadata. Missing on older runtimes/tests uses the local
     * roster and declared profile/catalog metadata; an empty live list does not.
     */
    listModelCatalog?: () => Promise<RuntimeModelCatalog>;
    managedModels?: boolean;
    createAgent(input: {
        brief: string;
        conversationMode?: "discuss";
        designSystemId?: string;
        provider?: string;
        model?: string;
        reasoningEffort?: string;
        kind?: "Slides";
        layout?: "16:9" | "4:3";
        attachments?: readonly EditorAttachment[];
    }): Promise<{
        sessionId: string;
        projectPath?: string;
    }>;
    resumeAgent(sessionId: string): Promise<void>;
    switchModel(sessionId: string, model: SlidesLlmModel, provider?: string, reasoningEffort?: string): Promise<void>;
    resolveAttachments?: (attachmentIds: readonly string[]) => Promise<readonly EditorAttachment[]>;
};
export declare function resolveEditorAttachments(attachmentIds: readonly string[], fetchImpl?: typeof fetch, editorOrigin?: string): Promise<EditorAttachment[]>;
export declare function turnTextWithAttachments(text: string, attachments: readonly EditorAttachment[]): string;
export type EditorReviewScope = Readonly<{
    kind: "elements" | "page";
    pageId: string;
    elementIds: readonly string[];
    pageRevision: number;
    pageSha256: string;
    commentId: string;
    commentRevision: number;
}>;
export declare function editorReviewScopeFromEdit(edit: Record<string, unknown>): EditorReviewScope | undefined;
/**
 * Review scopes for one turn: a single page/comment, or a cross-page batch.
 *
 * Pages are unique authorization baselines; multiple comments can target the
 * same page. Resolve by pageId rather than array position, preserving each
 * comment's exact element set and verifying every authorized page is covered.
 */
export declare function editorReviewScopesFromEdit(edit: Record<string, unknown>): readonly EditorReviewScope[] | undefined;
export declare function turnTextWithReviewScope(text: string, scope: EditorReviewScope | readonly EditorReviewScope[] | undefined): string;
export declare function handleProductRequest(runtime: SlidesHostRuntime, req: IncomingMessage, res: ServerResponse): boolean;
export declare function handleSlidesRequest(runtime: SlidesHostRuntime, req: IncomingMessage, res: ServerResponse): void;
//# sourceMappingURL=routes.d.ts.map