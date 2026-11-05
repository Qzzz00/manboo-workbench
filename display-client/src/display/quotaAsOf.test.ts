/**
 * **展示台的额度区也要说「截至什么时候」**(2026-10-02,卡 QA)。
 *
 * 现场:`/state.quota.claude` 是 Claude 桌面端 **04:27** 那个样本算出来的 `{5h:100%, 周:82%}`,
 * 到 21:3x 这块屏上还画着满条 —— 一个字都没说那个数多大年纪。老四家那两处(`displayBoard` 的
 * `quotaLines`、`orbitBoard` 的 `quotaAccounts`)原来都把 `stale` 写死成 `false`。
 *
 * 这一份也兼**对照测试**(AGENTS.md「改契约的卡」):那条线与那几句话的真相源在
 * `workbench-plugin/src/protocol.ts`,这里**读那个文件比对**,不写「逐字相同」的注释代替测试。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from './displayBoard';
import { quotaLines } from './displayBoard';
import { quotaAccounts } from './orbitBoard';
import {
  QUOTA_AS_OF_STALE_AFTER_MS, QUOTA_STALE_VALUE, quotaAsOfStale, quotaAsOfWords,
} from './workbenchProtocol';

const NOW = new Date(2026, 9, 2, 21, 30, 0);
const AT_0427 = new Date(2026, 9, 2, 4, 27, 40);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function state(asOf: string | undefined): BoardState {
  return {
    stale: false,
    sessions: [],
    agents: [{ id: 'claude', online: true, connected: true, waiting: 0, running: 0 }],
    quota: {
      claude: {
        kind: 'quota',
        windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
        ...(asOf === undefined ? {} : { as_of: asOf }),
      },
    },
  } as BoardState;
}

describe('额度区(一家一行):截至什么时候', () => {
  it('★过线(17 小时前的那一份):一条横条都不画,只写「读不到最新的 / 上次 04:27」,整行画淡', () => {
    const line = quotaLines(state(AT_0427.toISOString()), NOW).find((one) => one.name === 'Claude')!;
    expect(line.bars).toEqual([]);
    expect(line.value).toBe(QUOTA_STALE_VALUE);
    expect(line.note).toBe('上次 04:27');
    expect(line.stale).toBe(true);
  });

  it('★线以内:照画两条,小字里缀上「截至 HH:MM」', () => {
    const at = ago(30 * 60_000);
    const line = quotaLines(state(at.toISOString()), NOW).find((one) => one.name === 'Claude')!;
    expect(line.bars.map((bar) => bar.pct)).toEqual([100, 82]);
    expect(line.value).toBeUndefined();
    expect(line.note).toBe('截至 21:00');
    expect(line.stale).toBe(false);
  });

  it('as_of 缺席(老宿主)→ 与这一版之前一字不差', () => {
    const line = quotaLines(state(undefined), NOW).find((one) => one.name === 'Claude')!;
    expect(line.bars.map((bar) => bar.pct)).toEqual([100, 82]);
    expect(line.note).toBeUndefined();
    expect(line.stale).toBe(false);
  });

  it('★横屏那一份(orbitBoard)同一条线:过线不出百分比', () => {
    const over = quotaAccounts(state(AT_0427.toISOString()), NOW).accounts[0]!;
    expect(over.windows).toEqual([]);
    expect(over.value).toBe(QUOTA_STALE_VALUE);
    expect(over.note).toBe('上次 04:27');
    expect(over.stale).toBe(true);

    const inside = quotaAccounts(state(ago(30 * 60_000).toISOString()), NOW).accounts[0]!;
    expect(inside.windows.map((w) => w.pct)).toEqual([100, 82]);
    expect(inside.note).toBe('截至 21:00');
    expect(inside.stale).toBe(false);
  });

  it('★其余各家(agent_quota)过线时那一行**不消失**:摆「读不到最新的」,不是整行缺席', () => {
    // 服务端过线那一档把 left_pct / windows 全摘掉了,所以这边不能因为「没有数」就不画这一行。
    const withExtra = {
      ...state(undefined),
      // 展示台那份副本里没有 `short`(它只念 `line`),所以这里也不喂。
      agent_quota: [{
        id: 'muse', title: 'Muse', state: 'numbers' as const,
        line: '读不到最新的,上次昨晚 20:42',
        stale: true, read_at: new Date(2026, 9, 1, 20, 42).toISOString(),
      }],
    } as BoardState;
    const line = quotaLines(withExtra, NOW).find((one) => one.name === 'Muse')!;
    expect(line.value).toBe(QUOTA_STALE_VALUE);
    expect(line.bars).toEqual([]);
    expect(line.stale).toBe(true);

    const account = quotaAccounts(withExtra, NOW).accounts.find((one) => one.name === 'Muse')!;
    expect(account.value).toBe(QUOTA_STALE_VALUE);
    expect(account.windows).toEqual([]);
  });
});

describe('对照:与工作台那份协议同一条线、同一句话', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../workbench-plugin/src/protocol.ts'),
    'utf8',
  );

  it('★那条线是同一个数(读源头文件比对,不写「逐字相同」的注释代替测试)', () => {
    const found = /export const QUOTA_AS_OF_STALE_AFTER_MS = ([^\n]+)/.exec(source);
    expect(found).not.toBeNull();
    // eslint-disable-next-line no-eval
    expect(eval(found![1]!.trim())).toBe(QUOTA_AS_OF_STALE_AFTER_MS);
  });

  it('★过线那一格写的字是同一句', () => {
    expect(source).toContain(`export const QUOTA_STALE_VALUE = '${QUOTA_STALE_VALUE}'`);
  });

  it('★协议里那两个字段在(额度型两种都有)', () => {
    expect(source).toMatch(/export interface QuotaAsOf \{\s*as_of\?: string\s*source\?: string/);
    expect(source).toContain('export interface BalanceQuota extends QuotaAsOf');
    expect(source).toContain('export interface WindowQuota extends QuotaAsOf');
  });

  it('★那两句人话两边一字不差(「截至 04:27」/「读不到最新的,上次 04:27」)', () => {
    // 工作台那一份的实现在源头文件里;这里拿同一组输入比对自己这一份的输出。
    expect(quotaAsOfWords(AT_0427.toISOString(), NOW)).toBe(`${QUOTA_STALE_VALUE},上次 04:27`);
    expect(quotaAsOfWords(ago(30 * 60_000).toISOString(), NOW)).toBe('截至 21:00');
    expect(quotaAsOfWords(undefined, NOW)).toBeUndefined();
    expect(quotaAsOfStale(undefined, NOW)).toBe(false);
    expect(source).toContain('`截至 ${clock}`');
    expect(source).toContain('},上次${/^\\d/.test(clock) ? \' \' : \'\'}${clock}`');
  });
});
