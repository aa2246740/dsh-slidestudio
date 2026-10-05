import type { Context as ClientContext } from '@deepseek-ai/cordis';
import React from 'react';
export declare const name = "dsh-slidestudio-client";
export declare const inject: string[];
type PersonalRegistry = {
    open?: (feature: string) => boolean;
    suspend?: () => (restore?: boolean) => void;
    register: (feature: {
        id: string;
        title: string;
        description?: string;
        order?: number;
        component: React.ComponentType;
    }) => () => void;
};
type SlotsService = {
    inject(slot: string, callback: () => (() => void) | void): () => void;
    register(entry: Record<string, unknown>, component: React.ComponentType): () => void;
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        personal?: PersonalRegistry;
        slots: SlotsService;
    }
}
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map