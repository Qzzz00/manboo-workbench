/**
 * 手机上按会前 / 会中 / 会后看一场会(2026-10-13,卡「会议页不再空着」)。维护者原话:
 * 「会议里要有一些方便演示的历史会议案例,一样按照会前会中会后三个来看」。
 *
 * 钉的是这几条:
 *
 * 1. 点开一场 → 三个页签,**默认停在会后**(纪要与待办照旧在第一眼就看得到,老用例也靠这条);
 * 2. 会前 = 登记那一句 + 五问画像(带出处)+ 预案卡;没登记过的那一场照实说没有;
 * 3. 会中 = 有没有录音 / 几段 + 转写里的时间戳摆的那条线,并**明写它不是现场记号**;
 * 4. 演示用那几场在列表与详情里都标着,不冒充真会。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingPage } from '../src/meeting/MeetingPage';
import { SessionContext, type Session } from '../src/session';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import type { MeetingDetail } from '../src/meeting/meetingApi';
import type { MeetingRecentView } from '../src/api/protocol';
import {
  MEETING_DEMO_TAG,
  MEETING_NO_PREP_TEXT,
  MEETING_NO_RECORDING_TEXT,
  MEETING_NO_TIMELINE_TEXT,
  MEETING_TIMELINE_NOTE,
  meetingRecentLine,
} from '../src/meeting/meetingModel';
import { testMeetingController } from './meetingFakes';

const DEMO: MeetingDetail = {
  id: 'm1',
  title: '跟品牌方谈一条植入',
  date: '2026-10-13',
  status: 'done',
  segments: 0,
  demo: true,
  dir: '/Users/example/repo/会议/2026-10-13-跟品牌方谈一条植入',
  summary: '# 跟品牌方谈一条植入 · 纪要\n\n## 解决了什么\n\n1. 口播三十秒\n',
  todos: [{ id: 't1', what: '出一版脚本大纲', who: '小满', due: '周五之前' }],
  unsure: [],
  timeline: [
    { at: '00:00:00', text: '我们开始吧' },
    { at: '00:01:01', text: '三十秒左右' },
    { at: '00:04:10', text: '行,就这样' },
  ],
  prep: {
    said: '跟品牌方谈一条植入,今天下午三点,争取敲定排期和口播时长',
    when: '今天下午三点',
    scope: { value: '外部', from: 'said' },
    kind: { value: '谈判会', from: 'asked' },
    people: { value: [{ alias: '品牌方', role: '拍板', decides: true }, { alias: '小满', role: '执行' }], from: 'asked' },
    decider: { value: '品牌方', from: 'asked' },
    my_role: { value: '参与者', from: 'asked' },
    goal: { value: '敲定排期和口播时长', from: 'said' },
    card_status: 'ready',
    card: {
      made_at: '2026-10-13T07:00:00.000Z',
      questions: [{ q: '排期能不能更早', line: '我按现在排的说。', fallback: '这个我会后给您补一份。', none: true }],
    },
  },
};

/** 真录的一场(有录音、没有会前登记):会前照实说没有,会中说得出录了多久。 */
const RECORDED: MeetingDetail = {
  id: 'm2',
  title: '上周的会',
  date: '2026-10-06',
  status: 'done',
  segments: 2,
  seconds: 523,
  summary: '# 上周的会 · 纪要\n',
  todos: [],
  unsure: [],
};

const RECENT: readonly MeetingRecentView[] = [
  { id: 'm1', title: '跟品牌方谈一条植入', date: '2026-10-13', status: 'done', demo: true },
  { id: 'm2', title: '上周的会', date: '2026-10-06', status: 'done' },
];

function mount(details: readonly MeetingDetail[] = [DEMO, RECORDED]) {
  const json = async <T,>(path: string, _init: RequestOptions = {}): Promise<ApiResult<T>> => {
    const hit = details.find(one => path.startsWith(`/meeting?id=${one.id}`));
    if (hit !== undefined) return { ok: true, status: 200, data: hit as T };
    return { ok: false, status: 404, kind: 'http', error: `没有这条路由:${path}` };
  };
  const client = { baseUrl: 'http://127.0.0.1:8791', json, blob: async () => ({ ok: false, status: 404, kind: 'http', error: '用不到' }) } as unknown as ApiClient;
  const feed = { subscribe: () => () => {}, get: () => ({ state: { now: '', meetings: { recent: RECENT } }, connected: true }) };
  const session = { direct: client, client, feed } as unknown as Session;
  const controller = testMeetingController({
    direct: client,
    routed: client,
    recorderDeps: { native: { start: async () => ({ dir: '/x' }), status: async () => ({ recording: false }), stop: async () => {}, pause: async () => {}, resume: async () => {}, level: async () => ({ level: 0 }), addListener: async () => ({ remove: async () => {} }) } as never, stopGraceMs: 10 },
  });
  render(<SessionContext.Provider value={session}><MeetingPage onClose={() => {}} controller={controller} pollMs={10} tickMs={20} /></SessionContext.Provider>);
}

async function click(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
}

/** 页签那三颗的 role 是 tab(不是 button)—— 一次只看一段,屏幕朗读也要念得出哪一段在前面。 */
async function tab(name: string): Promise<void> {
  const one = await screen.findByRole('tab', { name });
  await act(async () => { (one as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 20)); });
}

async function open(title: string | RegExp): Promise<void> {
  await click(title);
  await waitFor(() => { expect(screen.getAllByRole('tab')).toHaveLength(3); });
}

describe('一场会分会前 / 会中 / 会后看', () => {
  it('★ 点开一场:三个页签,默认停在会后(纪要与待办就在第一眼)', async () => {
    mount();
    await open(/跟品牌方谈一条植入/);
    expect(screen.getAllByRole('tab').map(one => one.textContent)).toEqual(['会前', '会中', '会后']);
    expect(screen.getByRole('tab', { name: '会后' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/跟品牌方谈一条植入 · 纪要/)).toBeTruthy();
    expect(screen.getByText('出一版脚本大纲')).toBeTruthy();
    expect(screen.getByText('小满')).toBeTruthy();
  });

  it('★ 会前:登记那一句、五问(带出处)、预案卡', async () => {
    mount();
    await open(/跟品牌方谈一条植入/);
    await tab('会前');
    expect(screen.getByText(DEMO.prep!.said)).toBeTruthy();
    expect(screen.getByText('今天下午三点')).toBeTruthy();
    expect(screen.getByText('外部')).toBeTruthy();
    // 出处照旧显示:这一答是她那句话里说的,还是她答的
    expect(screen.getAllByText('你那句话里说的').length).toBeGreaterThan(0);
    expect(screen.getByText('品牌方(拍板)、小满(执行)')).toBeTruthy();
    expect(screen.getByLabelText('预案卡')).toBeTruthy();
    expect(screen.getByText('排期能不能更早')).toBeTruthy();
    // 纪要这时不在屏上(一次只看一段)
    expect(screen.queryByText(/跟品牌方谈一条植入 · 纪要/)).toBeNull();
  });

  it('★ 会中:没有录音的那一场照实说;时间线是转写里的时间戳,并明写它不是现场记号', async () => {
    mount();
    await open(/跟品牌方谈一条植入/);
    await tab('会中');
    expect(screen.getByText(MEETING_NO_RECORDING_TEXT)).toBeTruthy();
    const line = screen.getByLabelText('时间线');
    expect(line.textContent).toContain('00:01:01');
    expect(line.textContent).toContain('三十秒左右');
    expect(screen.getByText(MEETING_TIMELINE_NOTE)).toBeTruthy();
  });

  it('真录的一场:会中说得出录了多久几段;没有会前登记就照实说(并说清怎么才会有)', async () => {
    mount();
    await open(/上周的会/);
    await tab('会中');
    expect(screen.getByText(/00:08:43 · 2 段录音/)).toBeTruthy();
    expect(screen.getByText(MEETING_NO_TIMELINE_TEXT)).toBeTruthy();
    await tab('会前');
    expect(screen.getByText(MEETING_NO_PREP_TEXT)).toBeTruthy();
  });

  it('演示用那几场:列表上标着,点开也标着(不冒充真会)', async () => {
    mount();
    expect(screen.getByText(meetingRecentLine(RECENT[0]!))).toBeTruthy();
    expect(meetingRecentLine(RECENT[0]!)).toContain(MEETING_DEMO_TAG);
    expect(meetingRecentLine(RECENT[1]!)).not.toContain(MEETING_DEMO_TAG);
    await open(/跟品牌方谈一条植入/);
    expect(screen.getByText(new RegExp(`${MEETING_DEMO_TAG}:这一场是放进来的虚构样例`))).toBeTruthy();
  });

  it('看完回得去:「回上一页」又是那张列表', async () => {
    mount();
    await open(/跟品牌方谈一条植入/);
    await click('回上一页');
    expect(screen.getByRole('button', { name: '开始录' })).toBeTruthy();
  });
});
