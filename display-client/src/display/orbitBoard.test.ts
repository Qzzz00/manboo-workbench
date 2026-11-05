/**
 * 第二套横屏展示台「环绕」的投影(2026-10-01,Pen.dev 稿「B · 中央粒子与环绕会话」)。
 *
 * 稿子的边界(Codex 写在画布上的,逐条钉):
 *   · 会话按**事项**一条一张卡(执行者、事项、最新进展、等你 / 在跑),不是按家分组;
 *   · 只有**在跑**的会话连到中央的球,等你的事项独立显示、不伪装成在执行;
 *   · 额度按**账号**,每个账号的**全部周期**都摆(不截成两条)、不合并不同模型组;
 *   · 「暂未取得额度」与「额度未接入」分别标明;九个账号同屏,不滑不翻页。
 */
import { describe, expect, it } from 'vitest';
import type { BoardState, RegistryEntry, RegistrySession } from './displayBoard';
import {
  MAX_ORBIT_SESSIONS, MAX_QUOTA_ACCOUNTS, orbitSessions, quotaAccounts, relativeAgo, splitSides, syncLine, windowName,
} from './orbitBoard';

const NOW = new Date('2026-10-01T22:02:00+08:00');

function session(over: Partial<RegistrySession> & { session_id: string }): RegistrySession {
  return { agent: 'claude', status: 'running', ...over };
}

function entry(over: Partial<RegistryEntry> & { id: string; name: string }): RegistryEntry {
  return { status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 }, ...over };
}

function state(entries: RegistryEntry[], extra: Partial<BoardState> = {}): BoardState {
  return { stale: false, agents: [], sessions: [], agent_registry: { entries }, ...extra };
}

describe('会话:按事项一张卡', () => {
  const board = state([
    entry({
      id: 'claude', name: 'Claude', color: '#d97757', status: 'running',
      sessions: [
        session({ session_id: 'a', title: '手机横屏 · 音乐与播客', summary: '补齐落后进度', updated_at: '2026-10-01T22:01:50+08:00' }),
        session({ session_id: 'b', title: '故障修复与验收', summary: '复核修复后的日志', updated_at: '2026-10-01T21:58:00+08:00' }),
        session({ session_id: 'c', title: '批准本次文件访问', status: 'waiting', summary: '批准后继续处理' }),
        session({ session_id: 'd', title: '早就说完的', status: 'done', unread: false }),
      ],
      counts: { running: 2, waiting: 1, unread: 0 },
    }),
    entry({
      id: 'codex', name: 'Codex', status: 'running',
      sessions: [session({ agent: 'codex', session_id: 'e', title: 'Space · 导出 PDF', summary: '验证长内容分页', updated_at: '2026-10-01T22:01:00+08:00' })],
    }),
  ]);

  it('执行者 = 那一家的名字与主色;标题、最新进展 · 多久前', () => {
    const cards = orbitSessions(board, new Set(), NOW);
    const first = cards.find((c) => c.key === 'claude:a')!;
    expect(first).toMatchObject({ agentId: 'claude', agentName: 'Claude', color: '#d97757', title: '手机横屏 · 音乐与播客', sub: '补齐落后进度 · 刚刚', status: 'running', statusText: '在跑', linked: true });
    expect(cards.find((c) => c.key === 'claude:b')!.sub).toBe('复核修复后的日志 · 4分钟前');
  });

  it('★等你的事项不连线;说完了且看过的不上屏', () => {
    const cards = orbitSessions(board, new Set(), NOW);
    const wait = cards.find((c) => c.key === 'claude:c')!;
    expect(wait).toMatchObject({ status: 'waiting', statusText: '等你', linked: false, sub: '批准后继续处理' });
    expect(cards.some((c) => c.key === 'claude:d')).toBe(false);
  });

  it('最多四张;挑的时候等你的优先(不会因为在跑的多就把等你的挤掉),摆的时候在跑在前', () => {
    const many = state([entry({
      id: 'claude', name: 'Claude', status: 'running',
      sessions: [
        ...['1', '2', '3', '4', '5'].map((id) => session({ session_id: id, title: `在跑 ${id}` })),
        session({ session_id: 'w', title: '等你拍板', status: 'waiting' }),
      ],
    })]);
    const cards = orbitSessions(many, new Set(), NOW);
    expect(cards).toHaveLength(MAX_ORBIT_SESSIONS);
    expect(cards.map((c) => c.status)).toEqual(['running', 'running', 'running', 'waiting']);
  });

  it('左右两侧:前一半在左(单数时左边多一张),稿子里四张 = 左二右二,两张 = 左一右一', () => {
    expect(splitSides([1, 2, 3, 4])).toEqual([[1, 2], [3, 4]]);
    expect(splitSides([1, 2])).toEqual([[1], [2]]);
    expect(splitSides([1, 2, 3])).toEqual([[1, 2], [3]]);
    expect(splitSides([])).toEqual([[], []]);
  });

  it('没接上的那家不摆会话;没登记表时退回老 sessions,一条不编', () => {
    const off = state([entry({ id: 'kimi', name: 'Kimi', status: 'unknown', sessions: [session({ agent: 'kimi', session_id: 'k' })] })]);
    expect(orbitSessions(off, new Set(), NOW)).toEqual([]);
    const old: BoardState = {
      stale: false,
      agents: [{ id: 'claude', online: true, connected: true, waiting: 0, running: 1 }],
      sessions: [{ agent: 'claude', session_id: 's', project: 'workbench', status: 'running', title: '老路', elapsed_sec: 60, unread: false, updated_at: '2026-10-01T22:00:00+08:00' }],
    } as unknown as BoardState;
    expect(orbitSessions(old, new Set(), NOW)).toMatchObject([{ agentName: 'Claude', title: '老路', sub: 'workbench · 2分钟前', linked: true }]);
  });

  it('响铃的排最前;出错的写「出错了」;刚完成没看的写「刚完成」', () => {
    const board2 = state([entry({
      id: 'claude', name: 'Claude', status: 'running',
      sessions: [
        session({ session_id: 'x', title: '坏了', status: 'error' }),
        session({ session_id: 'y', title: '好了', status: 'done', unread: true }),
        session({ session_id: 'z', title: '在响', status: 'waiting' }),
      ],
    })]);
    const cards = orbitSessions(board2, new Set(['claude:z']), NOW);
    expect(cards.find((c) => c.key === 'claude:x')!.statusText).toBe('出错了');
    expect(cards.find((c) => c.key === 'claude:y')!.statusText).toBe('刚完成');
    expect(cards.find((c) => c.key === 'claude:z')!.ringing).toBe(true);
  });

  it('多久前:一分钟内「刚刚」,一小时内「N分钟前」,一天内「N小时前」,再久写日期;读不出不写', () => {
    expect(relativeAgo('2026-10-01T22:01:30+08:00', NOW)).toBe('刚刚');
    expect(relativeAgo('2026-10-01T21:50:00+08:00', NOW)).toBe('12分钟前');
    expect(relativeAgo('2026-10-01T19:00:00+08:00', NOW)).toBe('3小时前');
    expect(relativeAgo('2026-09-28T19:00:00+08:00', NOW)).toBe('09-28');
    expect(relativeAgo('坏的', NOW)).toBeUndefined();
    expect(relativeAgo(undefined, NOW)).toBeUndefined();
  });
});

describe('额度:按账号,全部周期', () => {
  it('窗口名写全:5h → 5小时、总 → 总量,模型名原样(Sonnet 周…)', () => {
    expect(windowName('5h')).toBe('5小时');
    expect(windowName('周')).toBe('周');
    expect(windowName('总')).toBe('总量');
    expect(windowName('Sonnet')).toBe('Sonnet');
  });

  it('★Antigravity 回的英文长名也写成短的中文(10-01 真数据:「Weekly Limit Remaining」把组名挤没了)', () => {
    expect(windowName('Weekly Limit Remaining')).toBe('周');
    expect(windowName('Five Hour Limit Remaining')).toBe('5小时');
    expect(windowName('Daily Limit')).toBe('今日');
    expect(windowName('近7天')).toBe('近7天');
    expect(windowName('当前时段')).toBe('当前时段');
  });

  it('★老四家:三扇窗口全摆、不截两条;装了接上但读不到数 =「暂未取得额度」;没装的不摆', () => {
    const board: BoardState = {
      stale: false,
      agents: [
        { id: 'claude', online: true, connected: true, waiting: 0, running: 0 },
        { id: 'codex', online: true, connected: true, waiting: 0, running: 0 },
        { id: 'kimi', online: true, connected: true, waiting: 0, running: 0 },
      ],
      sessions: [],
      clients: { claude: { installed: true, connected: true }, codex: { installed: true, connected: true }, kimi: { installed: false } },
      quota: {
        claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 66 }, { label: '周', left_pct: 42 }, { label: 'Sonnet', left_pct: 78 }] },
        codex: { kind: 'unknown' },
        kimi: { kind: 'quota', windows: [{ label: '5h', left_pct: 10 }] },
      },
    } as unknown as BoardState;
    const { accounts, hidden } = quotaAccounts(board, NOW);
    expect(hidden).toBe(0);
    expect(accounts.map((a) => a.id)).toEqual(['claude', 'codex']);
    expect(accounts[0]).toMatchObject({ name: 'Claude', windows: [{ label: '5小时', pct: 66 }, { label: '周', pct: 42 }, { label: 'Sonnet', pct: 78 }] });
    expect(accounts[1]).toMatchObject({ name: 'Codex', empty: '暂未取得额度' });
  });

  it('★分了模型组的不合并:Antigravity 两组各两扇窗,按组摆', () => {
    const board = state([], {
      agent_quota: [{
        id: 'antigravity', title: 'Antigravity', state: 'numbers',
        windows: [
          { label: '5h', left_pct: 64, group: 'Gemini Models' },
          { label: '周', left_pct: 82, group: 'Gemini Models' },
          { label: '5h', left_pct: 50, group: 'Claude and GPT models' },
          { label: '周', left_pct: 38, group: 'Claude and GPT models' },
        ],
      }],
    });
    const [ag] = quotaAccounts(board, NOW).accounts;
    expect(ag!.windows).toEqual([]);
    expect(ag!.groups).toEqual([
      { name: 'Gemini Models', windows: [{ label: '5小时', pct: 64, level: 'ok' }, { label: '周', pct: 82, level: 'ok' }] },
      { name: 'Claude and GPT models', windows: [{ label: '5小时', pct: 50, level: 'ok' }, { label: '周', pct: 38, level: 'ok' }] },
    ]);
  });

  it('其余各家:没接入 =「额度未接入」;不限 / 积分写数;过期的写「几号读到的」', () => {
    const board = state([], {
      agent_quota: [
        { id: 'muse', title: 'Muse', state: 'unconnected' },
        { id: 'grok', title: 'Grok', state: 'unlimited' },
        { id: 'manus', title: 'Manus', state: 'numbers', left: { text: '2,690', unit: '积分' } },
        { id: 'doubao', title: '豆包办公', state: 'numbers', stale: true, read_at: '2026-09-27T10:00:00+08:00', windows: [{ label: '当前时段', left_pct: 85 }, { label: '近7天', left_pct: 73 }] },
        { id: 'cursor', title: 'Cursor', state: 'numbers' },
      ],
    });
    const byId = new Map(quotaAccounts(board, NOW).accounts.map((a) => [a.id, a]));
    expect(byId.get('muse')).toMatchObject({ empty: '额度未接入' });
    expect(byId.get('grok')).toMatchObject({ value: '不限' });
    expect(byId.get('manus')).toMatchObject({ value: '2,690 积分' });
    // 2026-10-02(卡 QA):小字从「09-27 读到的」改成「上次 09-27」—— 与过线那一档大字写的
    // 「读不到最新的」连起来念是一句整话。(服务端过线时会把 windows 摘掉;这一条喂的是手搭的 view,
    // 所以两扇窗还在,钉的是小字那一句。)
    expect(byId.get('doubao')).toMatchObject({ stale: true, note: '上次 09-27', windows: [{ label: '当前时段', pct: 85 }, { label: '近7天', pct: 73 }] });
    expect(byId.get('cursor')).toMatchObject({ empty: '暂未取得额度' });
  });

  it('剩得少的标出来:低于 20% 是 warn,0 是 danger', () => {
    const board = state([], { agent_quota: [{ id: 'x', title: 'X', state: 'numbers', windows: [{ label: '5h', left_pct: 0 }, { label: '周', left_pct: 12 }, { label: '月', left_pct: 60 }] }] });
    expect(quotaAccounts(board, NOW).accounts[0]!.windows.map((w) => w.level)).toEqual(['danger', 'warn', 'ok']);
  });

  it('同屏最多九个账号,多出来的报个数,不缩字号、不省周期', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, title: `A${i}`, state: 'unconnected' as const }));
    const { accounts, hidden } = quotaAccounts(state([], { agent_quota: many }), NOW);
    expect(accounts).toHaveLength(MAX_QUOTA_ACCOUNTS);
    expect(hidden).toBe(2);
  });
});

describe('额度区右上那一句', () => {
  it('断开了如实说(C1),连着就说在同步,还没收到过就说在等', () => {
    expect(syncLine({ stale: true, received: true })).toEqual({ text: '和电脑断开了 · 显示最后一次已知状态', alert: true });
    expect(syncLine({ stale: false, received: true })).toEqual({ text: '与电脑同步中', alert: false });
    expect(syncLine({ stale: false, received: false })).toEqual({ text: '正在等电脑的状态', alert: false });
  });
});
