/**
 * 手机包自己那一行(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * 构建时写进 `public/build.json`(scripts/write-build-stamp.mjs),随 Vite 进 dist/、
 * 随 `cap sync` 进 APK 的 `assets/public/` —— 设置页顶上那一行就读它。
 * **读不到就缺席**:不编一个版本号、也不编一个构建时间。
 */
import { describe, expect, it } from 'vitest';
import { buildStampLine, loadPhoneBuildStamp, parsePhoneBuildStamp, PHONE_BUILD_STAMP_URL } from '../src/update/buildStamp';

const FULL = {
  butler_app_tree: 'a'.repeat(40),
  built_at: '2026-10-03T06:08:50.842Z',
  dirty: false,
  version: '0.4.91',
  version_code: 40091,
};

describe('parsePhoneBuildStamp', () => {
  it('五格齐的那一份原样读出来', () => {
    expect(parsePhoneBuildStamp(FULL)).toEqual(FULL);
  });

  it('认不出的形状一律 undefined —— 不编一个', () => {
    expect(parsePhoneBuildStamp(null)).toBeUndefined();
    expect(parsePhoneBuildStamp('0.4.91')).toBeUndefined();
    expect(parsePhoneBuildStamp(42)).toBeUndefined();
    expect(parsePhoneBuildStamp([])).toBeUndefined();
  });

  it('某一格坏了只丢那一格,剩下的照用(老包里压根没有 version 那一格)', () => {
    const old = parsePhoneBuildStamp({ butler_app_tree: 'b'.repeat(40), built_at: '2026-09-28T01:02:03.000Z', dirty: true });
    expect(old?.version).toBeUndefined();
    expect(old?.built_at).toBe('2026-09-28T01:02:03.000Z');
    expect(old?.dirty).toBe(true);
    // 版本号形状不对也当没有(一个手改坏的 build.json 不许变成屏上那行字)
    expect(parsePhoneBuildStamp({ ...FULL, version: '1.0' })?.version).toBeUndefined();
    expect(parsePhoneBuildStamp({ ...FULL, built_at: '前天' })?.built_at).toBeUndefined();
    expect(parsePhoneBuildStamp({ ...FULL, dirty: 'yes' })?.dirty).toBeUndefined();
  });
});

describe('buildStampLine', () => {
  it('★版本 + 构建时间(本地时间,给人看的)', () => {
    const line = buildStampLine(FULL);
    expect(line).toMatch(/^版本 0\.4\.91 · 构建于 \d{2}-\d{2} \d{2}:\d{2}$/);
    // 时间是本地时区的那一刻 —— 用同一份 Date 算一遍,别让这条用例跟着机器时区飘
    const d = new Date(FULL.built_at);
    const two = (n: number) => `${n}`.padStart(2, '0');
    expect(line).toBe(`版本 0.4.91 · 构建于 ${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
  });

  it('构建时源码目录是脏的:照实说一句(那个包不等于任何一次提交)', () => {
    expect(buildStampLine({ ...FULL, dirty: true })).toContain('没提交');
  });

  it('只有版本号、没有时间:只说版本号,不编一个时间', () => {
    const line = buildStampLine({ version: '0.4.91' });
    expect(line).toBe('版本 0.4.91');
  });

  it('★没有版本号(老包、或者读不到 build.json):整行缺席', () => {
    expect(buildStampLine({ built_at: FULL.built_at })).toBeUndefined();
    expect(buildStampLine(undefined)).toBeUndefined();
  });
});

describe('loadPhoneBuildStamp', () => {
  it('读的是 build.json(跟着 APK 的 assets/public/ 走)', () => {
    expect(PHONE_BUILD_STAMP_URL).toBe('build.json');
  });

  it('★取回来什么就用什么', async () => {
    const got = await loadPhoneBuildStamp(async () => new Response(JSON.stringify(FULL), { status: 200 }));
    expect(got).toEqual(FULL);
  });

  it('404 / 坏 JSON / fetch 直接抛,一律 undefined,不吵不编', async () => {
    expect(await loadPhoneBuildStamp(async () => new Response('', { status: 404 }))).toBeUndefined();
    expect(await loadPhoneBuildStamp(async () => new Response('{ 不是 json', { status: 200 }))).toBeUndefined();
    expect(await loadPhoneBuildStamp(async () => { throw new Error('没网'); })).toBeUndefined();
  });
});
