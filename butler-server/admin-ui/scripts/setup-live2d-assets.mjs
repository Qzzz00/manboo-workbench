#!/usr/bin/env node
// 来源:Aiboo origin/main 1f430c3f admin-ui/scripts/setup-live2d-assets.mjs(改写)
//
// Aiboo 里这个脚本是把主项目 public/ 的 live2D 模型与 Cubism Core 软链进 admin-ui/public/。
// 本机版预览的模型走 butler-server 的签名预览 URL(上传的 zip 解压目录),不需要本地模型;
// 只需要 Cubism Core 运行时 public/live2dcubismcore.min.js——它已随仓库提交(Live2D 专有许可,
// 文件头自带许可链接,属于「可再分发代码」)。本脚本只做校验;缺了就从同仓库 display-client/public 复制一份。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // admin-ui/scripts
const publicDir = join(here, '..', 'public');
const core = join(publicDir, 'live2dcubismcore.min.js');
const fallback = join(here, '..', '..', '..', 'display-client', 'public', 'live2dcubismcore.min.js');

mkdirSync(publicDir, { recursive: true });
if (existsSync(core)) {
  console.log('✓ live2dcubismcore.min.js 已就位,Live2D 预览就绪。');
} else if (existsSync(fallback)) {
  copyFileSync(fallback, core);
  console.log('+ 从 display-client/public 复制了 live2dcubismcore.min.js。');
} else {
  console.error('✗ 找不到 live2dcubismcore.min.js:请从 Live2D 官网下载 Cubism SDK for Web,把 Core/live2dcubismcore.min.js 放到 admin-ui/public/。');
  process.exit(1);
}
