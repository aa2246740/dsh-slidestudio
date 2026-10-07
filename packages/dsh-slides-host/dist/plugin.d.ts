import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-tools";
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-attachment";
declare module "@deepseek-ai/cordis" {
    interface Context {
        webServer: {
            /** The listening port (set once the service has activated). */
            readonly port?: number;
            register(route: {
                kind: "exact" | "prefix";
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
            }): () => void;
        };
    }
}
export declare const name = "slides-host";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    workspaceRoot: z<string, string, "defined">;
    dataRoot: z<string, string, "defined">;
    editorBaseUrl: z<string, string, "defined">;
    /** Mounted inside the user's own DSH Host as a Personal feature. */
    personal: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    workspaceRoot: z<string, string, "defined">;
    dataRoot: z<string, string, "defined">;
    editorBaseUrl: z<string, string, "defined">;
    /** Mounted inside the user's own DSH Host as a Personal feature. */
    personal: z<boolean, boolean, "defined">;
}>>, "plain">;
export type SlidesHostConfig = {
    workspaceRoot?: string;
    dataRoot?: string;
    editorBaseUrl?: string;
    personal?: boolean;
};
export declare function runModelSwitchTransaction(input: {
    apply: () => void;
    activate: () => void | Promise<void>;
    rollback: () => void;
}): Promise<void>;
export declare function apply(ctx: Context, config?: SlidesHostConfig): void;
//# sourceMappingURL=plugin.d.ts.map