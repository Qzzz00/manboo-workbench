// 设置六组样张出静态页(2026-10-22):`OUT=<目录> node <vite> build --config dev/readability-sample/vite.settings.config.mjs`,
// 再用无头 Chrome 打开 `<目录>/settings.html?…`(本工作树起不了开发服务器时用这一条)。其余同 vite.config.mjs。
import { resolve } from 'node:path'
import base from './vite.config.mjs'

export default {
  ...base,
  base: './',
  build: {
    outDir: process.env.OUT ?? resolve(base.root, 'dist-settings'),
    emptyOutDir: true,
    rollupOptions: { input: { settings: resolve(base.root, 'settings.html') } },
  },
}
