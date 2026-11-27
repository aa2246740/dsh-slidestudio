import { createObservability } from '../../scripts/lib/observability.mjs'

export const logger = createObservability({ app: 'slidestudio-plugin', version: '0.3.3' })
