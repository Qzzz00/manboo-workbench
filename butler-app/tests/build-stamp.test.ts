/**
 * 每个 APK 里都要带着「出自哪一份源码」:public/build.json 随 Vite 原样进 dist/,
 * `npx cap sync android` 再把它拷进 assets/public/,发版那头 unzip 出来比 `git rev-parse HEAD:butler-app`。
 * 形状是统筹的发布脚本按它读的接缝,这里钉死;git 取不到时**不编一个**,非 0 退出。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildStamp, readAppVersion, readDirty, readTree, versionCodeOf } from '../scripts/write-build-stamp.mjs';

// jsdom 环境里 import.meta.url 不一定是 file:(见 tests/swarmSource.test.ts),用 cwd —— vitest 在 butler-app 里跑。
const appRoot = resolve(process.cwd());
const cli = join(appRoot, 'scripts/write-build-stamp.mjs');

const trash: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'butler-build-stamp-'));
  trash.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of trash) {
    // 删之前核前缀:只删自己 mkdtemp 出来的那几个。
    if (dir.includes('butler-build-stamp-') && dir.startsWith(tmpdir().replace(/\/$/, ''))) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('buildStamp 纯函数', () => {
  it('形状就是发布脚本读的那三格 + 版本号那两格,键的顺序也固定', () => {
    const now = new Date('2026-10-03T04:05:06.000Z');
    const tree = 'a'.repeat(40);
    expect(buildStamp({ tree, dirty: false, now, version: '0.4.91' })).toEqual({
      butler_app_tree: tree,
      built_at: '2026-10-03T04:05:06.000Z',
      dirty: false,
      version: '0.4.91',
      version_code: 40091,
    });
    // 发布脚本按键名读(butler_app_tree / dirty),新加的两格只许**追加在后面**。
    expect(Object.keys(buildStamp({ tree, dirty: true, now, version: '0.4.91' })))
      .toEqual(['butler_app_tree', 'built_at', 'dirty', 'version', 'version_code']);
  });

  it('built_at 是 ISO 8601(带 Z),dirty 原样带过去', () => {
    const stamp = buildStamp({ tree: 'b'.repeat(40), dirty: true, now: new Date(0), version: '0.4.91' });
    expect(stamp.built_at).toBe('1970-01-01T00:00:00.000Z');
    expect(stamp.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(stamp.dirty).toBe(true);
  });
});

/**
 * versionCode 必须**单调递增**,否则 Android 当成"降级"拒装。
 * 算法:`(major * 100 + minor) * 10000 + patch`,从版本号算出来 —— 同一份源码永远同一个数,
 * 不看构建时间(重打一次同一版装不上去才是更糟的那种错)。
 */
describe('versionCodeOf:从版本号算,单调递增', () => {
  it('0.4.91 → 40091;逐位进位都递增', () => {
    expect(versionCodeOf('0.4.91')).toBe(40091);
    expect(versionCodeOf('0.4.92')).toBe(40092);
    expect(versionCodeOf('0.5.0')).toBe(50000);
    expect(versionCodeOf('1.0.0')).toBe(1_000_000);
    expect(versionCodeOf('0.0.1')).toBe(1);
  });

  it('版本号大的算出来的数也大(抽几个相邻的真版本比一遍)', () => {
    const versions = ['0.4.89', '0.4.90', '0.4.91', '0.4.99', '0.4.100', '0.5.0', '0.99.9999', '1.0.0'];
    const codes = versions.map((v) => versionCodeOf(v));
    for (let i = 1; i < codes.length; i += 1) expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    // Android 的 versionCode 是 32 位有符号整数
    expect(codes[codes.length - 1]).toBeLessThan(2_147_483_647);
  });

  it('算不出来就抛,不编一个数', () => {
    expect(() => versionCodeOf('1.0')).toThrow();
    expect(() => versionCodeOf('0.4.91-beta')).toThrow();
    // 进位会撞车的那两种:minor 到三位、patch 到五位
    expect(() => versionCodeOf('0.100.0')).toThrow();
    expect(() => versionCodeOf('0.4.10000')).toThrow();
  });
});

describe('readAppVersion:与工作台同源', () => {
  it('读的就是 workbench-plugin/package.json 那个版本号', () => {
    const repoRoot = resolve(appRoot, '..');
    const want = (JSON.parse(readFileSync(join(repoRoot, 'workbench-plugin/package.json'), 'utf8')) as { version: string }).version;
    expect(readAppVersion()).toBe(want);
    expect(readAppVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('readTree / readDirty 在本仓库里真跑', () => {
  it('readTree 是 40 位小写十六进制,且等于 git rev-parse HEAD:butler-app', () => {
    const tree = readTree(appRoot);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    const expected = execFileSync('git', ['rev-parse', 'HEAD:butler-app'], { cwd: appRoot, encoding: 'utf8' }).trim();
    expect(tree).toBe(expected);
  });

  it('在仓库任意目录跑都是同一个值(HEAD:butler-app 相对仓库根)', () => {
    expect(readTree(resolve(appRoot, '..'))).toBe(readTree(join(appRoot, 'src')));
  });

  it('readDirty 回布尔,与 git status --porcelain 对 butler-app 的输出一致', () => {
    const porcelain = execFileSync('git', ['status', '--porcelain', '--', ':/butler-app'], { cwd: appRoot, encoding: 'utf8' });
    expect(readDirty(appRoot)).toBe(porcelain.trim().length > 0);
  });

  it('不在仓库里就抛,不编一个指纹', () => {
    expect(() => readTree(scratch())).toThrow();
  });
});

describe('package.json / .gitignore 这两处挂钩', () => {
  it('build 脚本第一步就写指纹', () => {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build.startsWith('node scripts/write-build-stamp.mjs')).toBe(true);
    // cap:sync / android:debug 都经 pnpm build,不用另挂一遍。
    expect(pkg.scripts['cap:sync']).toContain('pnpm build');
    expect(pkg.scripts['android:debug']).toContain('pnpm cap:sync');
  });

  it('.gitignore 忽略 public/build.json 与 android/version.properties(每次构建现生,不入库)', () => {
    const lines = readFileSync(join(appRoot, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(lines).toContain('public/build.json');
    // 不忽略它的话,构建一次就把 butler-app/ 翻成 dirty,发版那头的指纹核对当场 die。
    expect(lines).toContain('android/version.properties');
  });
});

/** 兜底那个占位值。手机那边 `parsePhoneVersion` **必须认不出它**(三段数字才认)。 */
const GRADLE_FALLBACK_NAME = '0.0.0-dev';

/**
 * APK 自己的版本号(2026-10-03)。`versionName` / `versionCode` **不手填**:
 * 构建时写进 `android/version.properties`,build.gradle 读它。
 */
describe('build.gradle 读 version.properties,不写死版本号', () => {
  const gradle = readFileSync(join(appRoot, 'android/app/build.gradle'), 'utf8');

  it('不再有写死的 versionName "1.0" / versionCode 1', () => {
    expect(gradle).not.toMatch(/versionName\s+"1\.0"/);
    expect(gradle).not.toMatch(/versionCode\s+1\s*$/m);
  });

  it('从 version.properties 取两格,取不到有个认得出来的兜底', () => {
    expect(gradle).toContain('version.properties');
    expect(gradle).toContain('versionName');
    expect(gradle).toContain('versionCode');
    // 没跑过 pnpm build 就直接 gradlew 的那种包:版本号如实是个占位值,
    // 手机那边 parsePhoneVersion 认不出 → 界面上说「认不出这个包的版本号」。
    expect(gradle).toContain(GRADLE_FALLBACK_NAME);
  });
});

describe('当 CLI 跑', () => {
  it('--out 写出来的文件能 JSON.parse、键齐全、两格缩进、末尾换行', () => {
    const out = join(scratch(), 'build.json');
    const r = spawnSync(process.execPath, [cli, '--out', out], { cwd: appRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);

    const raw = readFileSync(out, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "butler_app_tree"');

    const parsed = JSON.parse(raw) as { butler_app_tree: string; built_at: string; dirty: boolean; version: string; version_code: number };
    expect(Object.keys(parsed)).toEqual(['butler_app_tree', 'built_at', 'dirty', 'version', 'version_code']);
    expect(parsed.butler_app_tree).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.butler_app_tree).toBe(readTree(appRoot));
    expect(Number.isNaN(Date.parse(parsed.built_at))).toBe(false);
    expect(typeof parsed.dirty).toBe('boolean');
    // 版本号与工作台同源,不手填。
    expect(parsed.version).toBe(readAppVersion());
    expect(parsed.version_code).toBe(versionCodeOf(readAppVersion()));

    // stdout 一行人话:版本号 + 前 12 位 + dirty/clean。
    expect(r.stdout).toContain(`手机包指纹:${parsed.butler_app_tree.slice(0, 12)}`);
    expect(r.stdout).toContain(parsed.version);
    expect(r.stdout).toMatch(/\((dirty|clean)\)/);
  });

  it('★同一趟还写 version.properties(gradle 读它当 versionName / versionCode)', () => {
    const dir = scratch();
    const out = join(dir, 'build.json');
    const r = spawnSync(process.execPath, [cli, '--out', out], { cwd: appRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    // --out 没带 --props 时,properties 落在 build.json 旁边(测试跑完整条路也不碰仓库里那一份)。
    const props = join(dir, 'version.properties');
    expect(existsSync(props)).toBe(true);
    const text = readFileSync(props, 'utf8');
    expect(text).toContain(`versionName=${readAppVersion()}`);
    expect(text).toContain(`versionCode=${versionCodeOf(readAppVersion())}`);
    // 别人手改它没用,文件头说清楚。
    expect(text).toContain('write-build-stamp.mjs');
  });

  it('默认写 butler-app/public/build.json 与 android/version.properties(按脚本自己的位置算,不看 cwd)', () => {
    const src = readFileSync(cli, 'utf8');
    expect(src).toContain("'../public/build.json'");
    expect(src).toContain("'../android/version.properties'");
  });

  it('git 取不到就非 0 退出并说清,一个字节都不写', () => {
    const dir = scratch();
    const out = join(dir, 'build.json');
    const r = spawnSync(process.execPath, [cli, '--out', out], { cwd: dir, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    // version.properties 也一个字节都不写:写了的话 gradle 会拿一份与指纹不配的版本号打包。
    expect(existsSync(join(dir, 'version.properties'))).toBe(false);
    expect(`${r.stderr}`).toMatch(/git/);
  });
});
