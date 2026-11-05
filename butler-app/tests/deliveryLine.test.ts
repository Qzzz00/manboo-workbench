import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskView } from '../src/api/protocol';
import { clientDeliveryLine, clientDispatchDelivery } from '../src/api/protocol';
import { itemCard } from '../src/items/itemsModel';

/**
 * **派出去了没有**(2026-09-30 维护者拍板:派活成功不回电话,电脑与手机上都要一眼看得出来)。
 *
 * 手机这一份是照抄工作台的(两个工程互不 import),所以这里**读那个文件比对**——
 * 不写「逐字相同」的注释当同步(AGENTS.md「接缝与卡的规矩」)。
 */
const AT = '2026-09-30T20:00:00.000Z';

function card(over: Partial<TaskView['client_dispatch']> = {}) {
  const task: TaskView = {
    id: 't-1', title: '让豆包总结一下', status: 'doing', direction: 'mine',
    created_at: AT, updated_at: AT,
    client_dispatch: { status: 'sent', at: AT, family: 'doubao', ...over },
  };
  return itemCard(task);
}

describe('手机卡上那一格', () => {
  /*
   * ★ 2026-10-03(卡「两条接缝」):这四句里的家名从「豆包」改成「豆包办公」——
   * 手机那张退路表以前漂着(插件那头一直是「豆包办公」),电脑上与手机上说的是两个名字。
   * 现在家名先问登记表(主人下发的那一份),登记表里没有才查那张与插件对齐的退路表。
   */
  it('★四档各一句人话', () => {
    expect(card({ seen_at: AT }).delivery).toBe('已派出 · 豆包办公那边看到了');
    expect(card().delivery).toBe('按了发送,还没在豆包办公那边看到 —— 我在盯着');
    expect(card({ status: 'typed' }).delivery).toBe('没派出去:字写进豆包办公的输入框了,没发出去');
    expect(card({ status: 'failed', reason: '找不到窗口' }).delivery).toBe('没派出去:找不到窗口');
  });

  it('★ 登记表里有那一家时按登记表那个名字说(电脑上接上哪一个包,手机上就叫它)', () => {
    const task: TaskView = {
      id: 't-1', title: '写三个标题', status: 'doing', direction: 'mine', created_at: AT, updated_at: AT,
      client_dispatch: { status: 'sent', at: AT, family: 'doubao', seen_at: AT },
    };
    const live = { agent_registry: { entries: [{ id: 'doubao', name: '豆包工作', sessions: [] }] } } as never;
    expect(itemCard(task, live).delivery).toBe('已派出 · 豆包工作那边看到了');
  });

  it('★没派过窗口的那几张整格缺席(没有「没派活」这种话)', () => {
    const task: TaskView = { id: 't-2', title: '自己办', status: 'doing', direction: 'mine', created_at: AT, updated_at: AT };
    expect(itemCard(task).delivery).toBeUndefined();
  });

  it('★回答收回来了就是看到过(老记录没有 seen_at 也不冤枉它)', () => {
    expect(clientDispatchDelivery({ status: 'sent', at: AT, reply_state: 'done' })).toBe('seen');
  });

  it('★与工作台那一份是同一批字(读源文件比对,不靠注释)', () => {
    const source = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');
    for (const line of [
      '`已派出 · ${who}那边看到了`',
      '`按了发送,还没在${who}那边看到 —— 我在盯着`',
      '`没派出去:字写进${who}的输入框了,没发出去`',
    ]) expect(source).toContain(line);
    // 这一份自己也得真说那几句(照抄的那一侧)。
    expect(clientDeliveryLine({ status: 'sent', at: AT, seen_at: AT }, 'X')).toBe('已派出 · X那边看到了');
    expect(clientDeliveryLine({ status: 'sent', at: AT }, 'X')).toBe('按了发送,还没在X那边看到 —— 我在盯着');
    expect(clientDeliveryLine({ status: 'typed', at: AT }, 'X')).toBe('没派出去:字写进X的输入框了,没发出去');
  });
});
