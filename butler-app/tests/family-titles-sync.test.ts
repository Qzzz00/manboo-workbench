/**
 * ★ **手机那张退路表不许比主人多、也不许漂**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
 *
 * 现场(审计第二表第 8 条):「名字 → 家」的第三个池在手机这个包里,而且**已经漂了** ——
 * `doubao` 在插件那头是「豆包办公」,手机两张表(`api/protocol.ts` 的 `ASSIGNEE_NAMES` 与
 * `chat/chatModel.ts` 的 `DISPATCH_WHO`)都写着「豆包」:同一件事手机上说「豆包回来了」、
 * 电脑上说「豆包办公回来了」。靠「同一套」那句注释同步,没人跑得到。
 *
 * 这一条**直接读插件的源码**比对(顶层子目录互不 import,所以只能读文本):
 *   手机 `ASSIGNEE_NAMES` 的每一条必须是插件 `protocol.ts` 的 `ASSIGNEE_NAMES` 里那一条,
 *   **逐字相同**(⊆:主人那边新加一档,手机不跟也不红 —— 认不出的那一档原样显示)。
 *
 * 另一半由代码本身保证:`DISPATCH_WHO` 那张表**删了**,派活那几句话问 `dispatchWho()` ——
 * 先 `/state.agent_registry`(主人下发的那一份),登记表里没有才查这张退路表。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSIGNEE_NAMES, dispatchWho } from '../src/api/protocol';

const PLUGIN_SRC = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src');

/** 取出 `名字 = {` 到那一层的 `}` 之间那一段,并把注释行去掉(注释里也有引号)。 */
function objectBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `插件源码里找不到 ${marker} —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0);
  const start = source.indexOf('{', at);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start + 1, end)
    .split('\n')
    .map((line) => line.replace(/^\s*\/[/*].*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n');
}

/** 插件 `protocol.ts` 的 `ASSIGNEE_NAMES`:负责人 → 怎么称呼。 */
function pluginAssigneeNames(): Readonly<Record<string, string>> {
  const body = objectBody(readFileSync(join(PLUGIN_SRC, 'protocol.ts'), 'utf8'), 'export const ASSIGNEE_NAMES');
  const out: Record<string, string> = {};
  for (const hit of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']*)'/gm)) out[hit[1] as string] = hit[2] as string;
  return out;
}

describe('★ 家名 / 负责人怎么称呼:插件那份是主人', () => {
  it('读得到插件那张表(扫描本身没坏)', () => {
    const owner = pluginAssigneeNames();
    expect(Object.keys(owner).length).toBeGreaterThanOrEqual(8);
    expect(owner.dsh).toBe('事务官');
  });

  it('★ 手机那张退路表的每一条都与主人逐字相同(⊆;豆包那一格 10-03 前漂着)', () => {
    const owner = pluginAssigneeNames();
    for (const [id, name] of Object.entries(ASSIGNEE_NAMES)) {
      expect(
        owner[id],
        `手机 api/protocol.ts 的 ASSIGNEE_NAMES 里有主人没有的一档:${id}。插件 protocol.ts 的 ASSIGNEE_NAMES 是主人。`,
      ).not.toBeUndefined();
      expect(
        name,
        [
          `${id} 怎么称呼,手机与插件漂了(手机「${name}」/ 插件「${owner[id]}」)。`,
          '插件那份是主人:改它,再把 butler-app/src/api/protocol.ts 的 ASSIGNEE_NAMES 改成一样的。',
        ].join('\n'),
      ).toBe(owner[id]);
    }
  });

  it('★ 念那一家的名字先问主人下发的那一份(登记表),没有才查退路表,都没有原样用家名', () => {
    const live = { agent_registry: { entries: [{ id: 'doubao', name: '豆包工作', sessions: [] }] } } as never;
    expect(dispatchWho('doubao', live)).toBe('豆包工作');
    expect(dispatchWho('doubao')).toBe('豆包办公');
    // 运行时发现的那一家:登记表里有就叫得出,没有原样用包标识 —— 不猜一个名字。
    expect(dispatchWho('com.anysphere.sand')).toBe('com.anysphere.sand');
  });
});
