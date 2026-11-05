/**
 * 手机会议页上「整理好的会」(2026-10-13,卡「会议纪要按规则出 + 不靠现场录音的演示样例」)。
 *
 * 在这之前这一页只认**这台手机自己刚录的那一场**:App 一重开,纪要在手机上就再也打不开了,
 * 电脑上导进来的那一场更是看不见。演示要「电脑导入 → 手机上看纪要、勾待办」,所以把
 * `/state.meetings.recent` 摆出来:点一场 → 还是那张纪要与待办的脸(同一条 `GET /meeting?id=`)。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingPage } from '../src/meeting/MeetingPage';
import { SessionContext, type Session } from '../src/session';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import type { MeetingDetail } from '../src/meeting/meetingApi';
import type { MeetingRecentView } from '../src/api/protocol';
import { MEETING_RECENT_TITLE, meetingRecentLine } from '../src/meeting/meetingModel';
import { testMeetingController } from './meetingFakes';

const IMPORTED: MeetingDetail = {
  id: 'm9',
  title: '十一月选题会',
  date: '2026-10-13',
  status: 'done',
  segments: 0,
  dir: '/Users/example/repo/会议/2026-10-13-十一月选题会',
  summary: '# 十一月选题会 · 纪要\n\n## 解决了什么\n\n1. 下个月四条短的加一条长的\n',
  todos: [
    { id: 't1', what: '把那两条确定的选题框架写出来', who: '小满', due: '周五之前' },
    { id: 't2', what: '把平台对切片和搬运的规则查一份出来', due: '下周一之前' },
  ],
  unsure: [],
};

const RECENT: readonly MeetingRecentView[] = [
  { id: 'm9', title: '十一月选题会', date: '2026-10-13', status: 'done' },
  { id: 'm8', title: '上周的会', date: '2026-10-06', status: 'failed' },
];

function desk() {
  const calls: { path: string; body?: unknown }[] = [];
  let detail = IMPORTED;
  const json = async <T,>(path: string, init: RequestOptions = {}): Promise<ApiResult<T>> => {
    calls.push({ path, ...(init.body === undefined ? {} : { body: init.body }) });
    if (path.startsWith('/meeting?')) return { ok: true, status: 200, data: detail as T };
    if (path === '/meeting/apply') {
      // 「都建」发的是空清单(电脑那边把空当成全建),这里照它的口径。
      const picked = (init.body as { todos?: string[] }).todos ?? [];
      const wanted = picked.length === 0 ? IMPORTED.todos.map(one => one.id) : picked;
      detail = { ...IMPORTED, todos: IMPORTED.todos.map(one => (wanted.includes(one.id) ? { ...one, task_id: `task-${one.id}` } : one)) };
      return { ok: true, status: 200, data: { ok: true, created: wanted.map(one => `task-${one}`) } as T };
    }
    return { ok: false, status: 404, kind: 'http', error: `没有这条路由:${path}` };
  };
  const client = { baseUrl: 'http://127.0.0.1:8791', json, blob: async () => ({ ok: false, status: 404, kind: 'http', error: '用不到' }) } as unknown as ApiClient;
  return { client, calls };
}

function mount(recent: readonly MeetingRecentView[] = RECENT) {
  const d = desk();
  const feed = { subscribe: () => () => {}, get: () => ({ state: { now: '', meetings: { recent } }, connected: true }) };
  const session = { direct: d.client, client: d.client, feed } as unknown as Session;
  const controller = testMeetingController({
    direct: d.client,
    routed: d.client,
    recorderDeps: { native: { start: async () => ({ dir: '/x' }), status: async () => ({ recording: false }), stop: async () => {}, pause: async () => {}, resume: async () => {}, level: async () => ({ level: 0 }), addListener: async () => ({ remove: async () => {} }) } as never, stopGraceMs: 10 },
  });
  render(<SessionContext.Provider value={session}><MeetingPage onClose={() => {}} controller={controller} pollMs={10} tickMs={20} /></SessionContext.Provider>);
  return d;
}

async function click(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
}

describe('整理好的会(手机上点开看)', () => {
  it('★ 电脑上导进来的那一场在列表里;点开 → 纪要与待办照旧,能勾着建事项', async () => {
    const d = mount();
    expect(screen.getByText(MEETING_RECENT_TITLE)).toBeTruthy();
    expect(screen.getByText(meetingRecentLine(RECENT[0]!))).toBeTruthy();

    await click(/十一月选题会/);
    await waitFor(() => { expect(screen.getByText(/十一月选题会 · 纪要/)).toBeTruthy(); });
    expect(d.calls.some(one => one.path.startsWith('/meeting?id=m9'))).toBe(true);
    expect(screen.getByText('把那两条确定的选题框架写出来')).toBeTruthy();
    expect(screen.getByText('小满')).toBeTruthy();
    // 「谁」没说的那一条明写「没说谁」(同真录的一场)
    expect(screen.getByText('没说谁')).toBeTruthy();

    await click('都建');
    await waitFor(() => { expect(screen.getAllByText('已建')).toHaveLength(2); });
    // 「都建」= 不带清单(电脑那边把「没给」当成全建)
    expect(d.calls.find(one => one.path === '/meeting/apply')?.body).toEqual({ id: 'm9' });
  });

  it('看完回得去:点「回上一页」又是那张列表,「开始录」还在(没把会议页变成只能看纪要)', async () => {
    mount();
    await click(/十一月选题会/);
    await waitFor(() => { expect(screen.getByText(/十一月选题会 · 纪要/)).toBeTruthy(); });
    await click('回上一页');
    expect(screen.getByText(MEETING_RECENT_TITLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始录' })).toBeTruthy();
  });

  it('一场都没有(新装的手机、老工作台不给这一格)→ 整块不出现,首页照旧是「开始录」', () => {
    mount([]);
    expect(screen.queryByText(MEETING_RECENT_TITLE)).toBeNull();
    expect(screen.getByRole('button', { name: '开始录' })).toBeTruthy();
  });

  it('没整理成的那一场在列表里也说清状态(不装作好了)', () => {
    mount();
    expect(screen.getByText(meetingRecentLine(RECENT[1]!))).toBeTruthy();
    expect(meetingRecentLine(RECENT[1]!)).toContain('没整理成');
  });
});
