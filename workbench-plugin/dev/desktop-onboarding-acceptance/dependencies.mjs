import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** Resolve from this checkout's installed packages, including workspace dependency symlinks. */
export function resolveAcceptanceDependencies(plugin) {
  try {
    const require = createRequire(join(resolve(plugin), 'package.json'))
    // The installed DSH package explicitly exports src/*; its bundle is a host module factory.
    const storeSource = require.resolve('@deepseek-ai/dsh-client-store/src/index.ts')
    const storeRoot = dirname(require.resolve('@deepseek-ai/dsh-client-store/package.json'))
    // Vite is a Vitest dependency, not a direct dependency of the plugin.
    const viteEntry = createRequire(require.resolve('vitest/package.json')).resolve('vite')
    return { storeSource, storeRoot, viteEntry, fsAllow: [resolve(plugin, '..'), storeRoot] }
  } catch (cause) {
    throw new Error(`Acceptance requires installed source dependencies for ${plugin}: ${cause.message}`, { cause })
  }
}
