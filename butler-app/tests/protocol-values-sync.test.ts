/**
 * ★ **手机从插件抄的那批字面常量不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 值对:STATUS_TITLES、CASUAL_ASK_LABEL、FEATURE_STAGES、FEATURE_RUN_HINT、规矩 area 中文名、
 * 房间身份两常量(roomFromRelay)、中转设备类型。源头都在插件 / relay,手机各抄一份,靠注释
 * 互相指着,没有用例守着(几个已有用例只断言自己那边)。
 *
 * 直接读源头源码取字面量比对(顶层子目录互不 import,只能读文本;范本
 * `channel-worker/tests/calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASUAL_ASK_LABEL, STATUS_TITLES } from '../src/api/protocol';
import { FEATURE_STAGES } from '../src/feature/deckProtocol';
import { FEATURE_RUN_HINT } from '../src/feature/featureModel';
import { DEVICE_ID_ATTRIBUTE, PHONE_IDENTITY_PREFIX } from '../src/account/roomFromRelay';

const WP = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src');
const RELAY = join(import.meta.dirname, '..', '..', 'relay', 'server');
const BA = join(import.meta.dirname, '..', 'src');

/** 取插件 `export const <Name>: … = { … }` 那张表的 键:值(键可以是中文,表可单行可多行)。 */
function pluginTable(file: string, name: string): Record<string, string> {
  const source = readFileSync(join(WP, file), 'utf8');
  const at = source.indexOf(`export const ${name}`);
  expect(at, `插件 ${file} 里找不到 \`export const ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', at);
  const open = source.indexOf('{', at);
  const inner = source.slice(open + 1, end < open ? source.length : end);
  const out: Record<string, string> = {};
  for (const hit of inner.matchAll(/([^\s:]+):\s*'([^']*)'/g)) out[hit[1] as string] = hit[2] as string;
  return out;
}

/** 取插件 `export const <Name> = '…'` 的字面量。 */
function pluginStringConst(file: string, name: string): string {
  const source = readFileSync(join(WP, file), 'utf8');
  const hit = source.match(new RegExp(`export const ${name} = '([^']+)'`));
  expect(hit, `插件 ${file} 里找不到 \`export const ${name} = '…'\` —— 它改名了?这一条要跟着改`).not.toBeNull();
  return hit?.[1] as string;
}

describe('★ 手机抄的字面常量对照', () => {
  it('STATUS_TITLES:手机那份与插件 protocol.ts 那张表逐字相同', () => {
    expect({ ...STATUS_TITLES }).toEqual(pluginTable('protocol.ts', 'STATUS_TITLES'));
  });

  it('CASUAL_ASK_LABEL:值与插件 server/casualAsk.ts 的 CASUAL_ASK_NOTE 逐字相同(名字不同,值同)', () => {
    expect(CASUAL_ASK_LABEL).toBe(pluginStringConst('server/casualAsk.ts', 'CASUAL_ASK_NOTE'));
  });

  it('FEATURE_STAGES:手机 deckProtocol.ts 那份与插件 protocol.ts 那份逐字相同', () => {
    const plugin = readFileSync(join(WP, 'protocol.ts'), 'utf8');
    const hit = plugin.match(/export const FEATURE_STAGES: readonly FeatureStage\[] = \[([^\]]*)\]/);
    expect(hit, '插件 protocol.ts 里找不到 `FEATURE_STAGES = [ … ]`').not.toBeNull();
    const stages = [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(one => one[1] as string);
    expect([...FEATURE_STAGES]).toEqual(stages);
  });

  it('FEATURE_RUN_HINT:手机 featureModel.ts 那份与插件 client/FeatureDeckModel.ts 那份逐字相同', () => {
    expect({ ...FEATURE_RUN_HINT }).toEqual(pluginTable('client/FeatureDeckModel.ts', 'FEATURE_RUN_HINT'));
  });

  it('规矩 area 中文名:手机 RulesSection.tsx 的 AREA_TITLES 与插件 BUTLER_RULE_AREA_TITLES 逐字相同', () => {
    const phone = readFileSync(join(BA, 'settings', 'RulesSection.tsx'), 'utf8');
    const hit = phone.match(/const AREA_TITLES: Record<[^>]+> = \{([^}]*)\}/);
    expect(hit, '手机 RulesSection.tsx 里找不到 `AREA_TITLES = { … }`').not.toBeNull();
    const mine: Record<string, string> = {};
    for (const row of (hit?.[1] ?? '').matchAll(/([A-Za-z0-9_]+):\s*'([^']*)'/g)) mine[row[1] as string] = row[2] as string;
    expect(mine).toEqual(pluginTable('protocol.ts', 'BUTLER_RULE_AREA_TITLES'));
  });

  it('房间身份两常量:手机 roomFromRelay.ts 与插件 server/channel.ts 的 CHANNEL_PHONE_PREFIX / CHANNEL_DEVICE_ATTRIBUTE 同一个值', () => {
    expect(PHONE_IDENTITY_PREFIX).toBe(pluginStringConst('server/channel.ts', 'CHANNEL_PHONE_PREFIX'));
    expect(DEVICE_ID_ATTRIBUTE).toBe(pluginStringConst('server/channel.ts', 'CHANNEL_DEVICE_ATTRIBUTE'));
  });

  it('中转设备类型:手机 RelayDeviceKind 与 relay/server/accounts.cjs 的 DEVICE_KINDS 同一个值集', () => {
    const phone = readFileSync(join(BA, 'account', 'relayApi.ts'), 'utf8');
    const union = phone.match(/export type RelayDeviceKind = '([^']+)'(?:\s*\|\s*'([^']+)')*\s*;/);
    expect(union, '手机 relayApi.ts 里找不到 `export type RelayDeviceKind = …`').not.toBeNull();
    const at = phone.indexOf('export type RelayDeviceKind = ');
    const end = phone.indexOf('\n', at);
    const mine = [...phone.slice(at, end).matchAll(/'([^']+)'/g)].map(one => one[1] as string).sort();

    const relay = readFileSync(join(RELAY, 'accounts.cjs'), 'utf8');
    const set = relay.match(/const DEVICE_KINDS = new Set\(\[([^\]]*)\]\)/);
    expect(set, 'relay accounts.cjs 里找不到 `DEVICE_KINDS = new Set([…])`').not.toBeNull();
    const theirs = [...(set?.[1] ?? '').matchAll(/'([^']+)'/g)].map(one => one[1] as string).sort();
    expect(mine).toEqual(theirs);
  });
});
