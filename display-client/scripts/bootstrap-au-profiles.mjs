#!/usr/bin/env node
// bootstrap-au-profiles —— 扫 public/live2D/ 每个角色（含 *.model3.json 的目录），
// 自动生成 au-profile.json（P2）。幂等可重跑；--dry-run 只打印不写盘。
//
// 产出（每角色 public/live2D/<dir>/au-profile.json）：
//  - semanticBindings：按参数名正则 → SemanticAction（buildSemanticBindings）
//  - units：
//      * NativeExpressionUnit：每个 *.exp3.json 一个，情绪类按文件名播种情绪，
//        apparel/morph 类标 category 且不播种情绪
//      * SemanticExpressionUnit 骨架：对 0/少 exp3 角色，按命中的面部 region 生成
//        少量 param 驱动 AU 骨架（emotions 留空待人工/solver 调）
//  - rules：空（规则由 admin-ui / 后续人工补；本任务只产出类型可承载的结构）
//  - meta.todo：未命中映射的参数 + neutral 占位的 exp3（待人工补）
//
// 用法：
//   node scripts/bootstrap-au-profiles.mjs            # 写盘
//   node scripts/bootstrap-au-profiles.mjs --dry-run  # 只打印统计

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSemanticBindings,
  paramNameToSemanticAction,
  classifyExp3,
  seedEmotionsForExp3,
  exp3FileToNativeUnit,
  canonicalEmotionUnits,
  SEMANTIC_ACTIONS,
} from '../src/features/live2d/au/bootstrapRules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LIVE2D_ROOT = join(REPO_ROOT, 'public', 'live2D');
const AU_PROFILE_VERSION = 1;

const DRY_RUN = process.argv.includes('--dry-run');

// ── 工具 ─────────────────────────────────────────────────────────────────
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 在角色目录（含一层子目录）里找首个匹配后缀的文件名。 */
async function findFile(dir, suffix) {
  const entries = await listDir(dir);
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(suffix)) return join(dir, e.name);
  }
  return null;
}

/** 递归收集目录下全部 *.exp3.json，返回相对 dir 的路径（含子目录）。 */
async function globExp3(dir, base = dir) {
  const out = [];
  for (const e of await listDir(dir)) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await globExp3(full, base)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.exp3.json')) {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

/**
 * 列出角色的 exp3 引用，返回相对角色目录的路径数组。
 * 优先用 model3 FileReferences.Expressions[].File（权威，含子目录路径）；
 * model3 未声明时退回递归文件系统扫描。
 */
async function listExp3(dir, model3) {
  const refs = model3?.FileReferences?.Expressions || [];
  if (refs.length > 0) {
    return refs
      .map((r) => r?.File)
      .filter(Boolean)
      .sort();
  }
  return (await globExp3(dir)).sort();
}

/** 从 cdi3 / model3 收集参数名清单（优先 cdi3 的 Parameters[].Id）。 */
async function collectParamNames(dir) {
  const names = new Set();
  const cdi3Path = await findFile(dir, '.cdi3.json');
  if (cdi3Path) {
    const cdi3 = await readJson(cdi3Path);
    for (const p of cdi3?.Parameters || []) {
      if (p?.Id) names.add(p.Id);
    }
  }
  // 退路：model3 的 DisplayInfo 不一定含参数；cdi3 已足够。这里仅在 cdi3 缺失时
  // 尝试从 exp3 触碰的参数兜底（不完整，但能驱动绑定）。
  return [...names];
}

/** 读单个 exp3 触碰的参数 Id 清单（用于 region 推导）。 */
async function readExp3Params(path) {
  const exp = await readJson(path);
  return (exp?.Parameters || []).map((p) => p?.Id).filter(Boolean);
}

// ── 单角色处理 ───────────────────────────────────────────────────────────
async function buildProfileForDir(dir) {
  const dirName = basename(dir);
  const model3Path = await findFile(dir, '.model3.json');
  if (!model3Path) return null; // 不是模型目录

  const characterId = dirName;
  const model3 = await readJson(model3Path);
  const paramNames = await collectParamNames(dir);
  const exp3Files = await listExp3(dir, model3);

  // 1) semanticBindings
  const semanticBindings = buildSemanticBindings(paramNames);
  const boundActions = new Set(Object.keys(semanticBindings));
  const unmappedParams = paramNames.filter((n) => !paramNameToSemanticAction(n));

  // 2) Native AUs（每个 exp3 一个）
  const units = [];
  const todo = [];
  let nativeEmotion = 0;
  let nativeApparel = 0;
  let nativeMorph = 0;
  let nativeGesture = 0;
  let nativeProp = 0;
  for (const file of exp3Files) {
    const touched = await readExp3Params(join(dir, file));
    const unit = exp3FileToNativeUnit(file, touched);
    unit.type = 'native';
    units.push(unit);
    // 按 unit 实际归类计数（含名字认不出+不碰面部参数被降级的 prop），不再按文件名。
    const cat = unit.category; // 情绪类为 undefined
    if (cat === 'apparel') nativeApparel++;
    else if (cat === 'morph') nativeMorph++;
    else if (cat === 'gesture') nativeGesture++;
    else if (cat === 'prop') {
      nativeProp++;
      todo.push(`exp3 "${file}" 非面部参数开关，归 prop 排除出情绪池（如需当表情请在编辑器改）`);
    } else {
      nativeEmotion++;
      // 命不中情绪（neutral 占位）→ 标记待人工
      const seed = seedEmotionsForExp3(file);
      if (seed.neutral === 0.3) todo.push(`exp3 "${file}" 情绪未命中，当前 {neutral:0.3} 占位待人工`);
    }
  }

  // 3) 情绪语义单元：对「缺真实情绪表情」的 param 驱动角色（如 rattan/shuangsheng），
  //    按标准 FACS 映射生成 8 种情绪的语义表情单元（带数值+相关性），只驱动已绑定的
  //    标准面部动作（绝不碰头部/身体位置）。多 exp3 情绪角色（estella）以 Native 为主，不补。
  let semanticUnits = 0;
  if (nativeEmotion < 4) {
    const emoUnits = canonicalEmotionUnits(boundActions);
    for (const u of emoUnits) units.push(u);
    semanticUnits = emoUnits.length;
    if (semanticUnits > 0) {
      todo.push(`${semanticUnits} 个 FACS 标准情绪语义单元已自动生成（可在编辑器微调取值/相关性）`);
    }
  }

  if (unmappedParams.length > 0) {
    todo.push(`${unmappedParams.length} 个参数未命中 SemanticAction 映射（多为物理/身体/数字枚举参数，通常可忽略）`);
  }

  const profile = {
    version: AU_PROFILE_VERSION,
    characterId,
    semanticBindings,
    units,
    rules: [],
    meta: {
      generatedBy: 'scripts/bootstrap-au-profiles.mjs',
      generatedAt: new Date().toISOString().slice(0, 10),
      modelFile: basename(model3Path),
      todo,
    },
  };

  return {
    dir,
    characterId,
    profile,
    stats: {
      params: paramNames.length,
      boundActions: boundActions.size,
      unmappedParams: unmappedParams.length,
      exp3Total: exp3Files.length,
      nativeEmotion,
      nativeApparel,
      nativeMorph,
      nativeGesture,
      semanticUnits,
    },
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────────
async function main() {
  const entries = await listDir(LIVE2D_ROOT);
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(join(LIVE2D_ROOT, e.name));
  }
  dirs.sort();

  const results = [];
  for (const dir of dirs) {
    const r = await buildProfileForDir(dir);
    if (r) results.push(r);
  }

  // 输出统计
  console.log(`\nbootstrap-au-profiles ${DRY_RUN ? '(dry-run)' : ''} — 扫描 ${LIVE2D_ROOT}`);
  console.log('角色\t参数\t命中绑定\t未映射\texp3总\t情绪Native\t服饰\t形态\t动作\tSemantic骨架');
  for (const r of results) {
    const s = r.stats;
    console.log(
      `${r.characterId}\t${s.params}\t${s.boundActions}\t\t${s.unmappedParams}\t${s.exp3Total}\t${s.nativeEmotion}\t\t${s.nativeApparel}\t${s.nativeMorph}\t${s.nativeGesture}\t${s.semanticUnits}`,
    );
  }
  // 命中率以「15 个标准 SemanticAction 覆盖了几个」衡量（总参数含大量物理/身体参，做分母无意义）。
  const TOTAL_ACTIONS = SEMANTIC_ACTIONS.length;
  console.log(`\n语义动作覆盖率（命中 action / ${TOTAL_ACTIONS} 个标准动作）：`);
  for (const r of results) {
    const s = r.stats;
    const pct = Math.round((s.boundActions / TOTAL_ACTIONS) * 100);
    console.log(`  ${r.characterId}: ${pct}%（${s.boundActions}/${TOTAL_ACTIONS}）`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：未写盘。');
    return;
  }

  for (const r of results) {
    const outPath = join(r.dir, 'au-profile.json');
    await writeFile(outPath, JSON.stringify(r.profile, null, 2) + '\n', 'utf8');
    console.log(`写入 ${outPath}`);
  }
  console.log(`\n完成：${results.length} 个角色 au-profile.json 已写入。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
