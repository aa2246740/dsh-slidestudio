import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
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
export declare function apply(ctx: Context): void;
//# sourceMappingURL=dsh-slidestudio.d.ts.map