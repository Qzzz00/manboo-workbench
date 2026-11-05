/**
 * ★ **来电理由及其中文名不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 同一件事「事务官为什么打这个电话」三份 —— 源头在插件
 * (`workbench-plugin/src/protocol.ts` 的 `CALL_OUT_REASONS` / `CALL_OUT_REASON_TITLES`),
 * 抄本在工人(`channel-worker/src/callOut.ts`)与手机(`butler-app/src/call/incomingModel.ts` 的
 * `RING_REASON_TITLES`,注释「与 workbench-plugin 的 CALL_OUT_REASON_TITLES 逐字相同」)。
 * 工人的那一份对照在 `channel-worker/tests/call-reason-sync.test.ts`;这一份管手机。
 *
 * 直接读插件的源码比对字面量(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RING_REASON_TITLES } from '../src/call/incomingModel';

const PLUGIN_PROTOCOL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts');

function pluginReasons(): string[] {
  const source = readFileSync(PLUGIN_PROTOCOL, 'utf8');
  const hit = source.match(/export const CALL_OUT_REASONS: readonly CallOutReason\[] = \[([^\]]*)\]/);
  expect(hit, '插件 protocol.ts 里找不到 `CALL_OUT_REASONS = [ … ]` —— 它改名了?这一条要跟着改').not.toBeNull();
  return [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(one => one[1] as string);
}

function pluginReasonTitles(): Record<string, string> {
  const source = readFileSync(PLUGIN_PROTOCOL, 'utf8');
  const at = source.indexOf('export const CALL_OUT_REASON_TITLES');
  expect(at, '插件 protocol.ts 里找不到 `CALL_OUT_REASON_TITLES` —— 它改名了?这一条要跟着改').toBeGreaterThanOrEqual(0);
  const body = source.slice(at, source.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const hit of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']*)'/gm)) out[hit[1] as string] = hit[2] as string;
  return out;
}

describe('★ 来电理由及其中文名:插件那份是源头,手机这份照抄', () => {
  it('读得到插件那两张表(扫描本身没坏)', () => {
    expect(pluginReasons()).toEqual(['confirm', 'failed', 'done', 'ask', 'relay']);
    expect(pluginReasonTitles()).toMatchObject({ confirm: '等你确认', ask: '等你回答', relay: '回话来了' });
  });

  it('★ 手机 RING_REASON_TITLES 的键与插件 CALL_OUT_REASONS 逐字相同', () => {
    expect(Object.keys(RING_REASON_TITLES)).toEqual(pluginReasons());
  });

  it('★ 手机 RING_REASON_TITLES 与插件 CALL_OUT_REASON_TITLES 逐字相同(漂了就把两边收成一样)', () => {
    expect({ ...RING_REASON_TITLES }).toEqual(pluginReasonTitles());
  });
});
