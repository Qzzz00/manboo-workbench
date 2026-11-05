/**
 * ★ **展示台那份协议副本不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 展示台 `workbenchProtocol.ts` 是工作台线上协议的**等价副本**(文件头自注「★ 真相源是
 * `workbench-plugin/src/protocol.ts`。改那边必须同步这里」),只搬展示台用得到的部分,
 * 字段名一字不改、只加可选字段。额度那几条线(`QUOTA_AS_OF_STALE_AFTER_MS` / `QUOTA_STALE_VALUE` /
 * `quotaAsOfWords`…)已有 `quotaAsOf.test.ts` / `quotaKeyHint.test.ts` 读源头比对;这一份补
 * 剩下的可比对项:**会话来源那四家**(AGENT_IDS / AgentId)与两份文件的互相指认(改哪边都得
 * 同步另一边,这条指针本身不许过期)。
 *
 * 直接读插件源码比对(顶层子目录互不 import,只能读文本;范本
 * `display-client/src/swarm/swarmSource.test.ts`)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from './workbenchProtocol';

const PLUGIN_PROTOCOL = resolve(__dirname, '../../../workbench-plugin/src/protocol.ts');
const DISPLAY_COPY = resolve(__dirname, './workbenchProtocol.ts');

function typeUnion(source: string, name: string): string[] {
  const at = source.indexOf(`export type ${name} =`);
  expect(at, `源码里找不到 \`export type ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const line = source.slice(at, source.indexOf('\n', at));
  return [...line.matchAll(/'([^']+)'/g)].map(m => m[1] as string);
}

describe('★ 展示台协议副本:插件那份是真相源,这边照抄', () => {
  it('AGENT_IDS:展示台那份与插件 protocol.ts 那张表逐字相同', () => {
    const plugin = readFileSync(PLUGIN_PROTOCOL, 'utf8');
    const hit = plugin.match(/export const AGENT_IDS: readonly AgentId\[] = \[([^\]]*)\]/);
    expect(hit, '插件 protocol.ts 里找不到 `AGENT_IDS = [ … ]`').not.toBeNull();
    const ids = [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(m => m[1] as string);
    expect([...AGENT_IDS]).toEqual(ids);
  });

  it('AgentId 值域:展示台那份与插件那份同一个联合', () => {
    const plugin = readFileSync(PLUGIN_PROTOCOL, 'utf8');
    const display = readFileSync(DISPLAY_COPY, 'utf8');
    expect(typeUnion(display, 'AgentId').sort()).toEqual(typeUnion(plugin, 'AgentId').sort());
  });

  it('★ 两份文件互相指认:插件那头说「这里有一份展示台副本」,展示台这份说「真相源在插件」', () => {
    const plugin = readFileSync(PLUGIN_PROTOCOL, 'utf8');
    const display = readFileSync(DISPLAY_COPY, 'utf8');
    expect(plugin).toMatch(/display-client\/src\/display\/workbenchProtocol\.ts/);
    expect(display).toContain('真相源是 `workbench-plugin/src/protocol.ts`');
  });
});
