// 只构建 display-client 的展示台页面(display.html)与竖屏形象页(avatar.html),产物落到 butler-app/public/display/。
// 沿用 display-client 自己的 vite.config(react + legacy + base './'),只换入口与出口、不带它 52MB 的 public/。
import { defineConfig, type UserConfig } from 'vite';
import path from 'node:path';
import base from '../../display-client/vite.config.ts';

const displayClientRoot = path.resolve(__dirname, '../../display-client');
const outDir = path.resolve(__dirname, '../public/display');

export default defineConfig(() => {
  const cfg = base as UserConfig;
  return {
    ...cfg,
    root: displayClientRoot,
    publicDir: false,
    build: {
      ...cfg.build,
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        ...cfg.build?.rollupOptions,
        input: {
          display: path.resolve(displayClientRoot, 'display.html'),
          // 竖屏首页的形象区(2026-10-01):只有形象舞台的那一页。
          avatar: path.resolve(displayClientRoot, 'avatar.html'),
        },
      },
    },
  };
});
