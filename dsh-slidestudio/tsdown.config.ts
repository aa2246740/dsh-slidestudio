import { fileURLToPath } from 'node:url'
import { externalClientBundle } from './tools/client-build.mjs'

const bundles = externalClientBundle('dsh-slidestudio', ['lib/types/dsh-slidestudio.js'], {
  clientEntry: 'src/client/index.tsx',
})
// tsc preserves source-relative imports while its node input is two levels
// deeper. Bundle the one shared local logger from the checkout, not a duplicate.
for (const bundle of bundles) {
  if (bundle.platform === 'node') {
    bundle.alias = {
      '../../scripts/lib/observability.mjs': fileURLToPath(
        new URL('../scripts/lib/observability.mjs', import.meta.url),
      ),
    }
  }
}
export default bundles
