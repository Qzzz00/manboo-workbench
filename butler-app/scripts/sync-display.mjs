#!/usr/bin/env node
/**
 * 把 display-client 的展示台页面构建到 public/display/,并拷贝它在根路径下要的少量静态资源(背景图)。
 * 横屏 DisplayPage 用 iframe 嵌 ./display/display.html。
 * **不拷任何 Live2D 模型**(2026-10-21 维护者定:仓库与 App 里一个模型都不带,形象只从电脑上的 butler-server 上传、
 * 手机按需下载);Cubism Core 运行时 public/live2dcubismcore.min.js 随仓库提交,照旧。
 *
 * 需要 ../display-client 装过依赖(pnpm -C ../display-client install)。没装且 public/display 已有旧产物时只警告不重建;
 * 两者都没有就失败——横屏页不能静默变成空白。
 */
import { existsSync, mkdirSync, cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const displayClient = path.resolve(appRoot, '../display-client');
const outDir = path.join(appRoot, 'public/display');
const viteBin = path.join(displayClient, 'node_modules/vite/bin/vite.js');

/** 展示台页面引用的静态资源:`/backgrounds/…`、`/live2dcubismcore.min.js` 是根绝对路径 → butler-app/public/ 根下(core 已随仓库提交)。 */
const ROOT_ASSETS = [
  ['public/backgrounds', 'public/backgrounds'],
];

function log(msg) { console.log(`[sync-display] ${msg}`); }

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

if (!existsSync(viteBin)) {
  if (existsSync(path.join(outDir, 'display.html'))) {
    log(`display-client 没装依赖(${viteBin} 不存在),沿用已有的 public/display/。要重建:pnpm -C ../display-client install`);
  } else {
    console.error(`[sync-display] display-client 没装依赖,也没有旧产物。先跑:pnpm -C ../display-client install`);
    process.exit(1);
  }
} else {
  log('构建 display-client/display.html → public/display/');
  const r = spawnSync(process.execPath, [viteBin, 'build', '--config', path.join(here, 'vite.display.config.ts')], {
    cwd: displayClient, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const [from, to] of ROOT_ASSETS) {
  const src = path.join(displayClient, from);
  const dst = path.join(appRoot, to);
  if (!existsSync(src)) { console.error(`[sync-display] 缺资源 ${src}`); process.exit(1); }
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  log(`拷贝 ${from} (${(dirSize(dst) / 1024 / 1024).toFixed(1)} MB)`);
}
// 上一版(10-01)拷进来的内置形象与旧路径留在 public/display/ 里会被打进 APK:清掉。
for (const stale of ['avatars', 'live2D']) {
  const p = path.join(outDir, stale);
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); log(`清掉旧产物 public/display/${stale}/(App 不再带模型)`); }
}
log('完成');
