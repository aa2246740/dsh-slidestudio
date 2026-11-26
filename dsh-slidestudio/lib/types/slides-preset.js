import { SLIDES_DIRECTOR_PERSONA } from '@open-slidestudio/dsh-slides-host';
import { logger } from './logger.js';
/** The slide preset's director persona: single source in @open-slidestudio/slides-tools. */
const SLIDES_PERSONA_PREFIX = SLIDES_DIRECTOR_PERSONA;
export function registerSlidesPreset(ctx) {
    const presets = ctx.get('agentPresets');
    if (!presets?.register) {
        logger.log('warn', 'agent_preset_unavailable');
        return;
    }
    ctx.effect(() => presets.register({
        id: 'slides',
        name: 'DSH SlideStudio slides',
        description: 'Product PPT tools only. No bash, filesystem, or editor tools.',
        order: 10,
        plugins: [
            {
                id: 'persona',
                name: '@deepseek-ai/dsh-persona',
                config: {
                    prefix: SLIDES_PERSONA_PREFIX,
                    complete: true,
                    includeRuntimeContext: false,
                },
            },
            {
                id: 'slides-ask-user',
                name: '@deepseek-ai/dsh-tool-ask-user',
            },
        ],
    }));
}
//# sourceMappingURL=slides-preset.js.map