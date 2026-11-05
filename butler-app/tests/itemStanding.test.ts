import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ItemStandingView, TaskView } from '../src/api/protocol';
import {
  ITEM_EVIDENCE_SOURCE_TITLES, ITEM_STANDING_ACTION_TITLES, ITEM_STANDING_CASE_TITLES,
  itemStandingRequest, standingBadgeText, standingWaitingText,
} from '../src/api/protocol';
import { itemCard } from '../src/items/itemsModel';
import { CALL_LOG_FAIL_KINDS, parseCallLog } from '../src/call/incomingModel';

/**
 * 没办完的事项停在哪(2026-10-12,卡「没办完的事项说清楚」)在手机上:事项那一行带同一格小字,详情里三样 + 三颗。
 * 手机这一份是照抄工作台的(两个工程互不 import),这里**读那个文件比对**,不靠注释同步。
 */
const AT = '2026-10-10T02:00:00.000Z';
const SOURCE = readFileSync(resolve(process.cwd(), '../workbench-plugin/src/protocol.ts'), 'utf8');

/** 从工作台源文件里取一张 `export const NAME ... = { k: 'v', ... }` 表。 */
function tableOf(name: string): Record<string, string> {
  const start = SOURCE.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const body = SOURCE.slice(SOURCE.indexOf('{', SOURCE.indexOf('=', start)), SOURCE.indexOf('}', start) + 1);
  return Object.fromEntries([...body.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!]));
}

describe('与工作台那一份同一批字', () => {
  it('★三张表逐条相同', () => {
    expect(ITEM_STANDING_CASE_TITLES).toEqual(tableOf('ITEM_STANDING_CASE_TITLES'));
    expect(ITEM_EVIDENCE_SOURCE_TITLES).toEqual(tableOf('ITEM_EVIDENCE_SOURCE_TITLES'));
    expect(ITEM_STANDING_ACTION_TITLES).toEqual(tableOf('ITEM_STANDING_ACTION_TITLES'));
  });

  it('★卡面那一格、在等谁、三颗走哪个口:与工作台源文件里那几句一致', () => {
    for (const line of [
      "case 'agent': return `在等 ${agentName ?? '那一家'}`",
      "case 'unlock': return '在等你解锁电脑'",
      "const days = standing.idle_days === undefined || standing.idle_days < 1 ? '' : ` · 停了 ${standing.idle_days} 天`",
      "if (standing === 'result_unwritten') return { path: '/task/move', body: { id: taskId, status: 'confirm' } }",
      "if (standing === 'likely_moot') return { path: '/item/drive', body: { task_id: taskId } }",
    ]) expect(SOURCE).toContain(line);
    expect(standingWaitingText({ waiting_on: 'agent' }, 'Claude')).toBe('在等 Claude');
    expect(standingWaitingText({ waiting_on: 'unlock' })).toBe('在等你解锁电脑');
    expect(standingBadgeText({ case: 'result_unwritten', idle_days: 2 })).toBe('结果回来了没收进卡 · 停了 2 天');
    expect(standingBadgeText({ case: 'waiting_her', idle_days: 1 })).toBeUndefined();
    expect(itemStandingRequest('a', 'result_unwritten', 'continue')).toEqual({ path: '/task/move', body: { id: 'a', status: 'confirm' } });
    expect(itemStandingRequest('a', 'channel_failed', 'close')).toEqual({ path: '/task/move', body: { id: 'a', status: 'canceled' } });
    expect(itemStandingRequest('a', 'channel_failed', 'redispatch')).toEqual({ path: '/item/drive', body: { task_id: 'a' } });
    expect(itemStandingRequest('a', 'waiting_her', 'continue')).toEqual({ open: true });
  });
});

describe('事项那一行', () => {
  const standing: ItemStandingView = {
    case: 'channel_failed', waiting_on: 'nobody', next: '没送进 Manus,之后没再推进。重派,或者不做了就关掉',
    idle_days: 3, stalled: true, actions: ['continue', 'close', 'redispatch'],
    last: { what: '没送进 Manus:找不到窗口', at: AT, source: 'dispatch' },
  };

  it('要留意的那几种带一格小字;正常的、老工作台没给的不出', () => {
    const task: TaskView = { id: 't-1', title: '写三个标题', status: 'doing', direction: 'mine', created_at: AT, updated_at: AT, standing };
    expect(itemCard(task).standing).toBe('没派成,停着 · 停了 3 天');
    expect(itemCard({ ...task, standing: { case: 'in_motion', waiting_on: 'agent', next: 'x' } }).standing).toBeUndefined();
    const { standing: _drop, ...old } = task;
    expect(itemCard(old).standing).toBeUndefined();
  });
});

describe('来电台账:`failed` 是哪一种(2026-10-12)', () => {
  it('手机读台账时把 fail_kind 原样带上(认不出的值丢掉,不猜)', () => {
    const log = parseCallLog({
      entries: [
        { id: 'a', reason: 'ask', item_id: 't', title: '甲', at: AT, state: 'failed', fail_kind: 'moot' },
        { id: 'b', reason: 'ask', item_id: 't', title: '乙', at: AT, state: 'failed', fail_kind: '乱写' },
      ],
      missed: 0,
    });
    expect(log.entries[0]?.fail_kind).toBe('moot');
    expect(log.entries[1]?.fail_kind).toBeUndefined();
    // 与工作台那一份同一组值(读源文件比对)。
    expect(SOURCE).toContain("export const CALL_OUT_FAIL_KINDS: readonly CallOutFailKind[] = ['tech', 'declined', 'moot', 'unknown']");
    expect(CALL_LOG_FAIL_KINDS).toEqual(['tech', 'declined', 'moot', 'unknown']);
  });
});
