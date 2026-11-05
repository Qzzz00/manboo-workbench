/**
 * 展示台会话区与额度区的投影(2026-09-30 横屏补齐)。
 *
 * 维护者看着手机横屏:「Agent 显示都是下线状态,下面的额度也没有,更直接的说,下面的额度是些死的,
 * 不是根据实际账号现在接入了哪些动态展示的」。
 *
 * 夹具的形状照抄 2026-09-30 晚本机工作台 `/state` 的真实回包(字段名、窗口型会话、过期的数都在),
 * 只删了与这两块无关的字段。
 */
import { describe, expect, it } from 'vitest';
import { boardCounts, familyGroups, quotaLines, type BoardState } from './displayBoard';

const NOW = new Date('2026-09-30T21:50:00+08:00');

function registryState(): BoardState {
  return {
    stale: false,
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'claude', online: true, connected: true, waiting: 0, running: 1 },
      // 老字段:服务重启后没来过事件的一律 online:false —— 这就是「都显示下线」的来源之一,不能再看它。
      { id: 'codex', online: false, connected: false, waiting: 0, running: 0 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [],
    agent_registry: {
      entries: [
        {
          id: 'dsh', name: '事务官', self: true, color: '#dcdce0', status: 'idle', gaps: {},
          counts: { running: 0, waiting: 0, unread: 0 },
          sessions: [{ agent: 'dsh', session_id: 'session-f9221ed6', project: '工作台', status: 'error', elapsed_sec: 4825, unread: false, updated_at: '2026-09-30T12:30:06.000Z', title: '下班例程 2026-09-30。工作台已', via: 'sessions' }],
        },
        {
          id: 'claude', name: 'Claude', color: '#eb714d', app_running: true, status: 'running', gaps: {},
          title: '修手机横屏', counts: { running: 1, waiting: 0, unread: 0 },
          sessions: [
            { agent: 'claude', session_id: '70acd2e2-fb68', project: 'butler-app', status: 'running', elapsed_sec: 261, unread: false, updated_at: '2026-09-30T13:49:52.000Z', title: '修手机横屏:音乐/播客格式坏了', via: 'sessions' },
            { agent: 'claude', session_id: 'aaaa1111', project: 'workbench', status: 'done', elapsed_sec: 900, unread: true, updated_at: '2026-09-30T13:10:00.000Z', title: '捎话故障 ② ③', via: 'sessions' },
          ],
        },
        {
          id: 'muse', name: 'Muse', color: '#4e96ef', app_running: true, status: 'waiting', gaps: {},
          counts: { running: 0, waiting: 1, unread: 0 },
          sessions: [{ agent: 'muse', session_id: 'window:46a5c2fc', project: 'Muse', status: 'waiting', title: 'Explain Trojan protocol', via: 'window' }],
        },
        {
          id: 'codex', name: 'Codex', color: '#dcdce0', app_running: true, status: 'unknown',
          gaps: { status: '没接上:Codex 在不在跑以它的会话文件为准,读窗口这一路只补标题' },
          counts: { running: 0, waiting: 0, unread: 0 },
          sessions: [{ agent: 'codex', session_id: 'window:c1c43225', project: 'Codex', status: 'done', title: 'Space', elapsed_sec: 4, unread: false, updated_at: '2026-09-30T13:50:26.907Z', via: 'window' }],
        },
        {
          id: 'doubao', name: '豆包办公', color: '#ca8372', app_running: true, status: 'idle', gaps: {},
          counts: { running: 0, waiting: 0, unread: 0 }, sessions: [],
        },
      ],
    },
  };
}

describe('会话区:各家只认 agent_registry(同 Mac 顶栏、手机首页)', () => {
  it('★有登记表就按它列家:窗口型的几家(Muse、豆包办公)也在,名字用它的名字', () => {
    const groups = familyGroups(registryState(), new Set());
    expect(groups.map((g) => g.name)).toEqual(['事务官', 'Claude', 'Muse', 'Codex', '豆包办公']);
  });
  it('★灯色照 Mac entryLamp:等你 = 琥珀、在跑 = 绿、其余灰;不再看老 agents[].online', () => {
    const byName = Object.fromEntries(familyGroups(registryState(), new Set()).map((g) => [g.name, g]));
    expect(byName.Claude.lamp).toBe('teal');
    expect(byName.Muse.lamp).toBe('amber');
    expect(byName['豆包办公'].lamp).toBe('off');
  });
  it('★「没接上」照 Mac entryConnected:读不到在不在跑才算,说得出为什么;接上了的不说', () => {
    const byName = Object.fromEntries(familyGroups(registryState(), new Set()).map((g) => [g.name, g]));
    expect(byName.Codex.connected).toBe(false);
    expect(byName.Codex.line).toContain('没接上');
    expect(byName.Claude.connected).toBe(true);
    expect(byName['豆包办公'].connected).toBe(true);
    expect(byName['豆包办公'].line).toBe('空闲');
    // 事务官自己永远算接上
    expect(byName['事务官'].connected).toBe(true);
  });
  it('每家最多摆三条会话,等你 → 在跑 → 没看过的刚完成 → 其余;窗口型会话没有时长也不出 NaN', () => {
    const claude = familyGroups(registryState(), new Set()).find((g) => g.id === 'claude')!;
    expect(claude.sessions.map((s) => s.title)).toEqual(['修手机横屏:音乐/播客格式坏了', '捎话故障 ② ③']);
    const muse = familyGroups(registryState(), new Set()).find((g) => g.id === 'muse')!;
    expect(muse.sessions[0].meta).not.toContain('NaN');
    expect(muse.sessions[0].meta).toContain('等你');
  });
  it('★读它自己记录长出来的会话(via:records,2026-10-08 千问办公)同窗口型:不挂项目名', () => {
    const state = registryState();
    const muse = state.agent_registry!.entries.find((e) => e.id === 'muse')!;
    (muse as unknown as { sessions: unknown[] }).sessions = [{ agent: 'muse', session_id: 'window:1', project: 'Muse', status: 'running', title: '起草邮件', elapsed_sec: 30, via: 'records' }];
    const group = familyGroups(state, new Set()).find((g) => g.id === 'muse')!;
    expect(group.sessions[0].meta).toContain('在跑');
    expect(group.sessions[0].meta).not.toContain('Muse');
  });
  it('标题右边那一行是各家加起来(Claude 在跑 1、Muse 等你 1)', () => {
    expect(boardCounts(familyGroups(registryState(), new Set()))).toEqual({ waiting: 1, done: 0, running: 1 });
  });
  it('响铃的那条置顶', () => {
    const claude = familyGroups(registryState(), new Set(['claude:aaaa1111'])).find((g) => g.id === 'claude')!;
    expect(claude.sessions[0].title).toBe('捎话故障 ② ③');
    expect(claude.sessions[0].ringing).toBe(true);
  });
  it('老工作台没有登记表:退回老 agents + sessions(一行不编)', () => {
    const state: BoardState = {
      stale: false,
      agents: [{ id: 'claude', online: true, connected: true, waiting: 0, running: 1 }],
      sessions: [{ agent: 'claude', session_id: 'x1', project: 'p', status: 'running', elapsed_sec: 30, unread: false, updated_at: '' }],
    };
    const groups = familyGroups(state, new Set());
    expect(groups.map((g) => g.name)).toEqual(['Claude']);
    expect(groups[0].lamp).toBe('teal');
    expect(groups[0].sessions).toHaveLength(1);
  });
});

function quotaState(): BoardState {
  return {
    stale: false,
    agents: [
      { id: 'dsh', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'claude', online: true, connected: true, waiting: 0, running: 0 },
      { id: 'codex', online: false, connected: false, waiting: 0, running: 0 },
      { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 },
    ],
    sessions: [],
    model_mode: 'relay',
    clients: { claude: { installed: true, connected: true }, codex: { installed: true, connected: true }, kimi: { installed: true, connected: false }, wechat: { installed: true, connected: false } },
    quota: {
      dsh: { kind: 'quota', windows: [{ label: '今日', left_pct: 100 }] },
      claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 93 }, { label: '周', left_pct: 98 }] },
      codex: { kind: 'quota', windows: [{ label: '周', left_pct: 21, reset_at: '2026-10-04T03:44:44.000Z' }] },
      kimi: { kind: 'quota', windows: [{ label: '总', left_pct: 100 }] },
    },
    agent_quota: [
      { id: 'claude', title: 'Claude', state: 'numbers', line: '5 小时窗口还剩约 98%', level: 'ok', left_pct: 98 },
      { id: 'muse', title: 'Muse', state: 'numbers', level: 'ok', left_pct: 97, stale: true, read_at: '2026-09-26T13:52:56.697Z', line: '还剩约 97% · 09-26 21:52 读到的' },
      { id: 'doubao', title: '豆包办公', state: 'numbers', level: 'ok', left_pct: 99, windows: [{ label: '5h', left_pct: 99 }, { label: '周', left_pct: 99 }], line: '…' },
      { id: 'manus', title: 'Manus', state: 'numbers', level: 'ok', line: '剩 2,690 积分', left: { text: '2,690', unit: '积分', amount: 2690 } },
      {
        id: 'com.google.antigravity', title: 'Antigravity', state: 'numbers', level: 'ok', left_pct: 100, line: '还剩约 100%',
        windows: [
          { label: 'Weekly Limit Remaining', left_pct: 100, group: 'Gemini Models' },
          { label: 'Five Hour Limit Remaining', left_pct: 80, group: 'Gemini Models' },
          { label: 'Weekly Limit Remaining', left_pct: 60, group: 'Claude and GPT models' },
          { label: 'Five Hour Limit Remaining', left_pct: 100, group: 'Claude and GPT models' },
        ],
      },
      { id: 'grok', title: 'Grok Bot', state: 'unconnected', line: '没接上' },
      { id: 'jimeng', title: '即梦', state: 'unlimited', line: '不限' },
    ],
  };
}

describe('额度区:按这台电脑此刻真接上了哪几家,动态出', () => {
  it('★老四家只画装了且接上了的(clients);没接上的 Kimi 不画;其余几家从 agent_quota 来,没接上的不画', () => {
    const lines = quotaLines(quotaState(), NOW);
    expect(lines.map((l) => l.name)).toEqual(['DeepSeek', 'Claude', 'Codex', 'Muse', '豆包办公', 'Manus', 'Antigravity', '即梦']);
  });
  it('老四家用 /state.quota 的窗口(Claude 5h + 周),不被 agent_quota 那一条重复', () => {
    const claude = quotaLines(quotaState(), NOW).filter((l) => l.name === 'Claude');
    expect(claude).toHaveLength(1);
    expect(claude[0].bars.map((b) => `${b.label} ${b.pct}`)).toEqual(['5h 93', '周 98']);
  });
  it('DeepSeek 走中转时说清楚「工作台提供」', () => {
    const ds = quotaLines(quotaState(), NOW).find((l) => l.name === 'DeepSeek')!;
    expect(ds.note).toContain('工作台');
  });
  it('窗口型:一扇窗一条,名字缩成 5h / 周;同名窗口按分组取最紧的,最多两条', () => {
    const ag = quotaLines(quotaState(), NOW).find((l) => l.name === 'Antigravity')!;
    expect(ag.bars.map((b) => `${b.label} ${b.pct}`)).toEqual(['周 60', '5h 80']);
    const db = quotaLines(quotaState(), NOW).find((l) => l.name === '豆包办公')!;
    expect(db.bars.map((b) => b.label)).toEqual(['5h', '周']);
  });
  it('只有一个数的一条;没有分母的(积分)只写数不画条;不限写「不限」', () => {
    const lines = quotaLines(quotaState(), NOW);
    expect(lines.find((l) => l.name === 'Muse')!.bars).toEqual([{ label: '剩', pct: 97, level: 'ok' }]);
    const manus = lines.find((l) => l.name === 'Manus')!;
    expect(manus.bars).toEqual([]);
    expect(manus.value).toBe('2,690 积分');
    expect(lines.find((l) => l.name === '即梦')!.value).toBe('不限');
  });
  it('★读到的数已经老了:照实写上次是几号,不当成此刻的数', () => {
    const muse = quotaLines(quotaState(), NOW).find((l) => l.name === 'Muse')!;
    expect(muse.stale).toBe(true);
    // 2026-10-02(卡 QA):过线那一档大字写「读不到最新的」,所以小字跟着改成「上次 09-26」——
    // 两格连起来念是一句整话,原来那句「09-26 读到的」配上「读不到最新的」会打架。
    expect(muse.note).toBe('上次 09-26');
  });
  it('剩得少的变色:≤0 红、<20 黄', () => {
    const state = quotaState();
    state.quota = { ...state.quota, codex: { kind: 'quota', windows: [{ label: '周', left_pct: 12 }] }, claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 0 }] } };
    const lines = quotaLines(state, NOW);
    expect(lines.find((l) => l.name === 'Codex')!.bars[0].level).toBe('warn');
    expect(lines.find((l) => l.name === 'Claude')!.bars[0].level).toBe('danger');
  });
  it('老工作台(没有 clients / agent_quota):老四家有数就画,取不到数的不画「未接入」', () => {
    const lines = quotaLines({
      stale: false, sessions: [],
      agents: [{ id: 'claude', online: true, connected: true, waiting: 0, running: 0 }, { id: 'kimi', online: false, connected: false, waiting: 0, running: 0 }],
      quota: { claude: { kind: 'quota', windows: [{ label: '5h', left_pct: 50 }] }, kimi: { kind: 'unknown', note: '取数方式待实测' } },
    }, NOW);
    expect(lines.map((l) => l.name)).toEqual(['Claude']);
  });
});

describe('额度区的重置时刻(沿用 quotaCells 那几条老规矩)', () => {
  const at = (quota: BoardState['quota'], now: Date) => quotaLines({ stale: false, sessions: [], agents: [], quota }, now);
  it('★每个窗口各自挂自己的重置时刻 —— 只挑最紧的写会被读成整个额度那时才回来(真机误读实锤,Ben 点名要逐窗口)', () => {
    const lines = at({
      claude: { kind: 'quota', windows: [
        { label: '5h', left_pct: 60, reset_at: '2026-08-21T16:00:00.000Z' },
        { label: '周', left_pct: 66, reset_at: '2026-08-25T08:00:00.000Z' },
      ] },
    }, new Date('2026-08-21T20:10:00+08:00'));
    expect(lines[0].bars.map((b) => b.reset)).toEqual(['明天 00:00', '08-25']);
  });
  it('给人话时间,不是 ISO 串;认不出时间的窗口不挂', () => {
    const lines = at({ codex: { kind: 'quota', windows: [{ label: '周', left_pct: 40 }, { label: '5h', left_pct: 50, reset_at: 'bad' }] } }, new Date('2026-08-21T20:10:00+08:00'));
    expect(lines[0].bars.map((b) => b.reset)).toEqual([undefined, undefined]);
  });
  it('★相对时间随时间推移重算:前一天看是「明天」,当天早上再看是「今天」', () => {
    const quota = { codex: { kind: 'quota' as const, windows: [{ label: '周', left_pct: 5, reset_at: '2026-08-20T03:33:00.000Z' }] } };
    expect(at(quota, new Date('2026-08-19T22:00:00+08:00'))[0].bars[0].reset).toBe('明天 11:33');
    expect(at(quota, new Date('2026-08-20T09:20:00+08:00'))[0].bars[0].reset).toBe('今天 11:33');
  });
});
