// 把真粒子球打成原型能直接 <script> 引的一个文件:
// 在 workbench-plugin 下 `node_modules/.bin/vite build --config dev/collab-prototype-orb/vite.config.mjs`。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const plugin = resolve(here, '..', '..')
const nm = name => resolve(plugin, 'node_modules', name)
export default {
  root: here,
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: [
    { find: /^react\/jsx-runtime$/, replacement: nm('react/jsx-runtime.js') },
    { find: /^react-dom\/client$/, replacement: nm('react-dom/client.js') },
    { find: /^react-dom$/, replacement: nm('react-dom/index.js') },
    { find: /^react$/, replacement: nm('react/index.js') },
  ] },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: resolve(plugin, '..', 'docs/assets/collab-wireframe-1027/product'),
    emptyOutDir: false,
    lib: { entry: resolve(here, 'entry.tsx'), formats: ['iife'], name: 'ProductOrbBundle', fileName: () => 'particle-orb.js' },
  },
}
