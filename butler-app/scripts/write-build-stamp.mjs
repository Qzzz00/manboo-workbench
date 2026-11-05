#!/usr/bin/env node
/**
 * 往 butler-app/public/build.json 写一行「这个包出自哪一份源码」,随 Vite 原样进 dist/,
 * `npx cap sync android` 再拷进 android 的 assets/public/ —— 于是每个 APK 里都带着自己的源码指纹。
 *
 * 为什么要有它:09-28 的 0.4.53–0.4.56 连续四版带的都是旧 APK(发布脚本只看
 * `android/app/build/outputs/apk/debug/app-debug.apk` 在不在就复制),手机侧几张修复卡没到手机,
 * 而更新页的总版本号照样往上走 —— 见 docs/审计-0928至1003-反复修复根因-2026-10-03.md 第一节 P1。
 * 这一半边只负责「让包自己说出身」;发版那头核对(unzip 出来比 git rev-parse HEAD:butler-app)是另一张卡。
 *
 * 形状固定(统筹的发布脚本按它读,改之前先改那边):
 *   {"butler_app_tree":"<40 位小写十六进制>","built_at":"<ISO>","dirty":false,
 *    "version":"0.4.91","version_code":40091}
 * 发布脚本按**键名**读 `butler_app_tree` 与 `dirty`,所以后来加的格一律**追加在后面**。
 *
 * 2026-10-03 多了版本号那半边(卡 claude/phone-in-app-update,维护者:「包也没有版本号」):
 * 同一趟还写 `android/version.properties`,build.gradle 读它当 `versionName` / `versionCode` ——
 * 手机包没有自己的版本号,它跟着工作台一起发,所以版本号与 `workbench-plugin/package.json` **同源**、
 * 构建时写入、不手填。
 *
 * git 取不到的时候**不编一个**:非 0 退出。没有 build.json,发版那头按「不符」处理。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 这个脚本自己在哪儿。两处默认落点都按它算,不看 cwd。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ tree: string, dirty: boolean, now: Date, version: string }} args
 * @returns {{ butler_app_tree: string, built_at: string, dirty: boolean, version: string, version_code: number }}
 */
export function buildStamp({ tree, dirty, now, version }) {
  // 键的顺序就是文档里那一行的顺序;JSON.stringify 按插入序输出。
  return { butler_app_tree: tree, built_at: now.toISOString(), dirty, version, version_code: versionCodeOf(version) };
}

/**
 * 工作台这一版的版本号 —— 手机包跟着它一起发,所以**同源**(不手填、不单独编一个)。
 * 路径按脚本自己的位置算(仓库里任意 cwd 都是同一份),取不到 / 形状不对就抛。
 * @returns {string}
 */
export function readAppVersion() {
  const file = path.resolve(here, '../../workbench-plugin/package.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${file}(${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = JSON.parse(raw);
  const version = parsed?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`workbench-plugin/package.json 的 version 不是三段数字:「${String(version)}」`);
  }
  return version;
}

/**
 * `versionName` → `versionCode`。
 *
 * **必须单调递增**:Android 拿它判新旧,小了一点就当成降级、直接拒装。
 * 算法 `(major * 100 + minor) * 10000 + patch` —— 从版本号算,**不看构建时间**:
 * 同一份源码重打一次要得出同一个数(时间戳会让"重打一版"装不回去,那是更糟的错)。
 * 容量:minor < 100、patch < 10000,major 到 214 都还在 32 位有符号整数里。
 * @param {string} version
 * @returns {number}
 */
export function versionCodeOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (m === null) throw new Error(`算不出 versionCode:「${version}」不是三段数字`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 超出容量就抛:悄悄回绕会算出一个比上一版小的数,那正是"装不上去"的那种错。
  if (minor > 99) throw new Error(`算不出 versionCode:minor ${minor} 超过 99(进位会撞车)`);
  if (patch > 9999) throw new Error(`算不出 versionCode:patch ${patch} 超过 9999(进位会撞车)`);
  const code = (major * 100 + minor) * 10000 + patch;
  if (code > 2_147_483_647) throw new Error(`算不出 versionCode:${code} 超出 32 位有符号整数`);
  return code;
}

/**
 * gradle 读的那两行。
 * @param {{ version: string }} args
 * @returns {string}
 */
export function versionProperties({ version }) {
  return [
    '# 由 butler-app/scripts/write-build-stamp.mjs 每次构建写入,手改无用(下一次 pnpm build 就盖掉)。',
    '# 版本号与 workbench-plugin/package.json 同源 —— 手机包跟着工作台一起发,没有自己的版本号。',
    `versionName=${version}`,
    `versionCode=${versionCodeOf(version)}`,
    '',
  ].join('\n');
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`跑不动 git(${r.error.message})`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败(${r.status}):${`${r.stderr ?? ''}`.trim() || '没有错误输出'}`);
  return `${r.stdout ?? ''}`;
}

/**
 * butler-app 这棵子树在 HEAD 里的 tree 对象 id。
 * `HEAD:butler-app` 这种写法的路径**相对仓库根**(不是 cwd),所以在仓库任意目录跑都是同一个值。
 * @param {string} cwd @returns {string}
 */
export function readTree(cwd) {
  const tree = git(['rev-parse', 'HEAD:butler-app'], cwd).trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`git 回的不是 40 位十六进制:「${tree}」`);
  return tree;
}

/**
 * butler-app 底下有没有未提交的改动(含未跟踪的文件)。
 * pathspec 用 `:/butler-app`(magic `:/` = 相对工作树顶),否则在 butler-app/ 里跑时 `-- butler-app` 匹配不上。
 * public/build.json 自己在 .gitignore 里,所以写它不会把 dirty 翻成 true。
 * @param {string} cwd @returns {boolean}
 */
export function readDirty(cwd) {
  return git(['status', '--porcelain', '--', ':/butler-app'], cwd).trim().length > 0;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const j = argv.indexOf('--props');
  const out = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.resolve(here, '../public/build.json');
  /**
   * gradle 那一份的落点。`--props` 直指;只带 `--out` 时**落在 build.json 旁边** ——
   * 用例把两份都引到临时目录里,整条路跑一遍也碰不到仓库里那一份。
   */
  const props = j >= 0 && argv[j + 1]
    ? path.resolve(argv[j + 1])
    : i >= 0 && argv[i + 1]
      ? path.join(path.dirname(out), 'version.properties')
      : path.resolve(here, '../android/version.properties');

  let tree;
  let dirty;
  let version;
  try {
    tree = readTree(process.cwd());
    dirty = readDirty(process.cwd());
    version = readAppVersion();
  } catch (err) {
    console.error('[build-stamp] 取不到源码指纹或版本号,这一版两份都不写(发版那头会按「没有 build.json = 不符」处理):');
    console.error(`[build-stamp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(buildStamp({ tree, dirty, now: new Date(), version }), null, 2)}\n`);
  mkdirSync(path.dirname(props), { recursive: true });
  writeFileSync(props, versionProperties({ version }));
  console.log(`手机包指纹:${tree.slice(0, 12)}(${dirty ? 'dirty' : 'clean'}),版本 ${version}(versionCode ${versionCodeOf(version)})`);
}

// 被 import 时什么都不做(用例要那两个纯函数);jsdom 里 import.meta.url 不一定是 file:,所以包起来。
function isCli() {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isCli()) main();
