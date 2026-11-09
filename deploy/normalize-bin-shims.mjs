#!/usr/bin/env node
/**
 * 出包前归一化 pnpm 生成的 node_modules/.bin 垫片。
 *
 * pnpm install 会把「出包机器的绝对路径」写死进每个垫片的 NODE_PATH:
 *   export NODE_PATH="/Users/<谁>/…/node_modules/.pnpm/…"
 * 这既把构建机的用户名与目录结构带进了公开发布包,装到用户机器上又必然失效。
 * 这里改成由垫片自身位置推算,任何机器上都成立:
 *   export NODE_PATH="$(cd "$basedir/.." && pwd)${NODE_PATH:+:$NODE_PATH}"
 *
 * 用法: node deploy/normalize-bin-shims.mjs <目录> [...]
 * 幂等:已经不含绝对路径的文件直接跳过,重复跑不会改字节。
 * 认不出结构却仍带绝对路径的垫片会报错中断 —— 宁可不出包,也不悄悄带出去。
 */
import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('用法: node normalize-bin-shims.mjs <目录> [...]');
  process.exit(1);
}

const BLOCK = /if \[ -z "\$NODE_PATH" \]; then\n[\s\S]*?\nfi\n/;
const REPLACEMENT =
  '# 出包归一化:NODE_PATH 由垫片自身位置推算,不带构建机绝对路径。\n' +
  'export NODE_PATH="$(cd "$basedir/.." && pwd)${NODE_PATH:+:$NODE_PATH}"\n';
const ABS = /(?:^|["':=\s])\/(?:Users|home|root|opt|tmp|private|var)\//m;

let scanned = 0;
let changed = 0;
const unhandled = [];

function scanBin(binDir) {
  let names;
  try { names = fs.readdirSync(binDir); } catch { return; }
  for (const name of names) {
    const file = path.join(binDir, name);
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    scanned += 1;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!ABS.test(text)) continue; // 已归一化,或本来就没有绝对路径
    const out = text.replace(BLOCK, REPLACEMENT);
    if (out === text) { unhandled.push(file); continue; }
    fs.writeFileSync(file, out); // 已存在的文件只截断写入,mode 不变
    changed += 1;
  }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // pnpm 的软链接会绕回同一棵树
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === '.bin') { scanBin(p); continue; }
    walk(p);
  }
}

for (const r of roots) {
  const abs = path.resolve(r);
  if (!fs.existsSync(abs)) {
    console.error(`× 目录不存在: ${abs}`);
    process.exit(1);
  }
  walk(abs);
}

console.log(`  垫片归一化: 扫 ${scanned} 个,改 ${changed} 个`);
if (unhandled.length > 0) {
  console.error(`× ${unhandled.length} 个垫片仍带绝对路径但结构认不出来:`);
  for (const f of unhandled.slice(0, 10)) console.error(`    ${f}`);
  process.exit(1);
}
