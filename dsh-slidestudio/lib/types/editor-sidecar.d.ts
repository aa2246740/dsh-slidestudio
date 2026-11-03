import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ChildProcess } from 'node:child_process';
/** Lazily spawns the editor sidecar on its own loopback port. */
export declare function startEditorSidecar(repoRoot: string, dataRoot: string, port: number): ChildProcess | undefined;
/** Pipes one request to the editor sidecar; mirrors the standalone shell's product proxy. */
export declare function proxyToSidecar(req: IncomingMessage, res: ServerResponse, editorOrigin: string): void;
//# sourceMappingURL=editor-sidecar.d.ts.map