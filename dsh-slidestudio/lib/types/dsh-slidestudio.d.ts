import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
export declare const name = "dsh-slidestudio";
export declare const inject: string[];
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
type StartSidecar = (repoRoot: string, dataRoot: string, port: number) => ChildProcess | undefined;
type WaitSidecar = (origin: string) => Promise<boolean>;
export type EditorSupervisor = {
    origin: () => string;
    ensure: () => Promise<boolean>;
    stop: () => void;
};
/** Restart the editor after an unexpected exit instead of latching the first failure. */
export declare function createEditorSupervisor(options: {
    repoRoot: string;
    dataRoot: string;
    port: number;
    cooldownMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    start?: StartSidecar;
    wait?: WaitSidecar;
}): EditorSupervisor;
export declare function apply(ctx: Context): void;
export {};
//# sourceMappingURL=dsh-slidestudio.d.ts.map