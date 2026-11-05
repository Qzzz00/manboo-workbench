/**
 * **展示台上「读不到最新」那一行也说清为什么**(2026-10-02,卡 QK)。
 *
 * 卡 QA 之后这块屏上写的是「读不到最新的 / 上次 04:27」—— 不骗人了,可**为什么**读不到、
 * 她能做什么,一个字都没有。那两句(「Claude 桌面没在跑」「点一下「接上」就实时」)
 * 由各家额度来源自己声明(工作台 `quota/liveSources.ts` 一处),跟着额度一起过来,这块屏只念。
 *
 * 两处都钉:竖屏额度区(`displayBoard` 的 `quotaLines`)、横屏额度条(`orbitBoard` 的 `quotaAccounts`)。
 * **那颗入口键这块屏不画** —— 展示台是看板,不是遥控器(`desk_only`)。
 *
 * 这一份也兼**对照测试**(AGENTS.md「改契约的卡」):那个字段与那一句的拼法真相源在
 * `workbench-plugin/src/protocol.ts`,这里**读那个文件比对**,不写「逐字相同」的注释代替测试。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardState } from './displayBoard';
import { quotaLines } from './displayBoard';
import { quotaAccounts } from './orbitBoard';
import type { QuotaStaleHint } from './workbenchProtocol';
import { QUOTA_STALE_VALUE, quotaStaleNote } from './workbenchProtocol';

const NOW = new Date(2026, 9, 2, 21, 30, 0);
const AT_0427 = new Date(2026, 9, 2, 4, 27, 40);

/**
 * 工作台顶上来的那一份(来源自己声明的两句 + 那颗只在电脑上画的键)。
 *
 * ★ 2026-10-03(卡「Claude 额度一键接上」):第二句与那颗键的字都换了 ——
 * 原来是「配一把 Claude 的密钥就能实时」/「去设置里配」,维护者照着那句话去配,发现要先在
 * 终端里跑一条命令,于是说:「你得考虑产品化啊,你不说我咋知道要咋弄啊。」现在那一步只剩一颗
 * 「接上」键(工作台自己去开浏览器让她授权),所以这句话也跟着改成她真要做的那一下。
 * **这块屏一个字没动**:它照旧只念工作台顶上来的那一句(下面最后一组读源头文件比对)。
 */
const HINT: QuotaStaleHint = {
  why: 'Claude 桌面没在跑',
  live: {
    why: '点一下「接上」,在浏览器里用 Claude 账号授权一次就实时',
    fix: { label: '去接上', at: { group: 'agents', row: 'claude_api' }, desk_only: true },
  },
};

function state(hint?: QuotaStaleHint): BoardState {
  return {
    stale: false,
    sessions: [],
    agents: [{ id: 'claude', online: true, connected: true, waiting: 0, running: 0 }],
    quota: {
      claude: {
        kind: 'quota',
        windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
        as_of: AT_0427.toISOString(),
        ...(hint === undefined ? {} : { stale_hint: hint }),
      },
    },
  } as BoardState;
}

describe('竖屏额度区(一家一行)', () => {
  it('★过线那一行小字里三段都在:上次几点 · 为什么 · 配上什么就能实时', () => {
    const line = quotaLines(state(HINT), NOW).find((one) => one.name === 'Claude')!;
    expect(line.value).toBe(QUOTA_STALE_VALUE);
    expect(line.note).toBe(`上次 04:27 · ${HINT.why} · ${HINT.live!.why}`);
    expect(line.stale).toBe(true);
    // 过线那一行一个百分比都不许留下。
    expect(line.bars).toEqual([]);
    expect(`${line.value}${line.note}`).not.toContain('%');
  });

  it('★没声明的那一家(没有更实时的来源)只剩「上次 HH:MM」—— 与卡 QA 一字不差', () => {
    const line = quotaLines(state(undefined), NOW).find((one) => one.name === 'Claude')!;
    expect(line.note).toBe('上次 04:27');
  });

  it('★这块屏上不出现任何密钥、也不出现技术词(她在屏前只需要知道该去电脑上做什么)', () => {
    const line = quotaLines(state(HINT), NOW).find((one) => one.name === 'Claude')!;
    const text = `${line.value ?? ''}${line.note ?? ''}`;
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toContain('setup-token');
    expect(text).not.toContain('API Key');
  });

  it('其余各家那一行(agent_quota)也跟着说那两句', () => {
    const withExtra = {
      ...state(undefined),
      agent_quota: [{
        id: 'muse', title: 'Muse', state: 'numbers' as const,
        line: '读不到最新的,上次昨晚 20:42',
        stale: true,
        read_at: new Date(2026, 9, 1, 20, 42).toISOString(),
        stale_hint: { why: 'Muse 没开着', live: { why: '登一次就能实时' } },
      }],
    } as BoardState;
    const line = quotaLines(withExtra, NOW).find((one) => one.name === 'Muse')!;
    expect(line.note).toBe('上次 10-01 · Muse 没开着 · 登一次就能实时');
  });
});

describe('横屏额度条(按账号)', () => {
  it('★同一套说法(一处拼),过线不出百分比', () => {
    const account = quotaAccounts(state(HINT), NOW).accounts[0]!;
    expect(account.value).toBe(QUOTA_STALE_VALUE);
    expect(account.note).toBe(`上次 04:27 · ${HINT.why} · ${HINT.live!.why}`);
    expect(account.windows).toEqual([]);
  });

  it('★没声明的那一家只剩「上次 HH:MM」', () => {
    expect(quotaAccounts(state(undefined), NOW).accounts[0]!.note).toBe('上次 04:27');
  });
});

describe('对照:与工作台那一处同一个字段、同一套拼法', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../workbench-plugin/src/protocol.ts'),
    'utf8',
  );
  const decl = readFileSync(
    resolve(__dirname, '../../../workbench-plugin/src/quota/liveSources.ts'),
    'utf8',
  );

  it('★契约那一处有这个字段与这两种形状(读源头文件比对)', () => {
    expect(source).toContain('stale_hint?: QuotaStaleHint');
    expect(source).toMatch(/export interface QuotaStaleHint \{\s*why\?: string\s*live\?: QuotaLiveHint/);
    expect(source).toContain('export interface QuotaLiveHint');
    expect(source).toContain('export interface QuotaStaleFix');
  });

  it('★那一句的拼法两边一字不差(同一组输入、同一个输出)', () => {
    expect(source).toContain('export function quotaStaleNote(');
    expect(quotaStaleNote(AT_0427.toISOString(), NOW, HINT))
      .toBe(`上次 04:27 · ${HINT.why} · ${HINT.live!.why}`);
    expect(quotaStaleNote(AT_0427.toISOString(), NOW, undefined)).toBe('上次 04:27');
    expect(quotaStaleNote(undefined, NOW, undefined)).toBe('');
  });

  it('★那两句话的出处是工作台那一处声明(不是这块屏自己编的)', () => {
    expect(decl).toContain(`export const CLAUDE_STALE_WHY = '${HINT.why}'`);
    expect(decl).toContain(`export const CLAUDE_LIVE_WHY = '${HINT.live!.why}'`);
    expect(decl).toContain("at: { group: 'agents', row: 'claude_api' }");
  });
});
