/**
 * 手机会议页里的会前(2026-10-10,卡「会前画像与预案」):待开的会列出来 → 点开一问一答 →
 * 目的说不清先拦(只能复制,不发)→ 预案卡只读 →「开始录这场」接到同一场;会后回一句「定下来没有」。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingPage } from '../src/meeting/MeetingPage';
import { meetingPlanNeedsLook } from '../src/meeting/MeetingPrepPanel';
import { SessionContext, type Session } from '../src/session';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import type { MeetingPlanView } from '../src/api/protocol';
import type { MeetingDetail } from '../src/meeting/meetingApi';
import { testMeetingController } from './meetingFakes';

const PLAN: MeetingPlanView = {
  id: 'p1', title: '跟 B 客户谈下季度合作', date: '2026-10-10', status: 'planned',
  prep: {
    said: '下午三点跟 B 客户谈下季度合作', when: '下午三点',
    scope: { value: '外部', from: 'said' },
    ask: { id: 'kind', text: '什么类型的会?', choices: ['例会', '谈判会'] },
    card_status: 'answers',
  },
};

function desk(after: MeetingDetail | undefined = undefined) {
  const calls: { path: string; body: unknown }[] = [];
  const json = async <T,>(path: string, init: RequestOptions = {}): Promise<ApiResult<T>> => {
    calls.push({ path: path.split('?')[0]!, body: init.body });
    if (path === '/meeting/answer') {
      const meeting = { ...PLAN, prep: { ...PLAN.prep!, kind: { value: '谈判会', from: 'asked' }, ask: undefined, goal_unclear: true, organizer_ask: '这次会主要想定哪几件事?我好提前准备。', card_status: 'goal' } };
      delete (meeting.prep as { ask?: unknown }).ask;
      return { ok: true, status: 200, data: { ok: true, meeting, note: '先问问组织者' } as T };
    }
    if (path === '/meeting/start') return { ok: true, status: 200, data: { ok: true, id: 'p1' } as T };
    if (path.startsWith('/meeting?')) return { ok: true, status: 200, data: after as T };
    if (path === '/meeting/outcome') return { ok: true, status: 200, data: { ok: true } as T };
    return { ok: true, status: 200, data: { ok: true } as T };
  };
  const blob = async (): Promise<ApiResult<Blob>> => ({ ok: false, status: 404, kind: 'http', error: '用不到' });
  const client = { baseUrl: 'http://x', json, blob } as ApiClient;
  return { client, calls };
}

function recorderDeps() {
  const plugin = {
    start: async () => ({ dir: '/files/meetings/1' }), status: async () => ({ recording: false }),
    pause: async () => {}, resume: async () => {}, stop: async () => {}, level: async () => ({ level: 0.4 }),
    addListener: async () => ({ remove: async () => {} }),
  };
  return { native: plugin as never, stopGraceMs: 10 };
}

function mount(plans: readonly MeetingPlanView[], d = desk()) {
  const feed = { subscribe: () => () => {}, get: () => ({ state: { now: '', meetings: { upcoming: plans } }, connected: true }) };
  const session = { direct: d.client, client: d.client, feed } as unknown as Session;
  const controller = testMeetingController({ direct: d.client, routed: d.client, recorderDeps: recorderDeps(), segmentMs: 60_000 });
  render(<SessionContext.Provider value={session}><MeetingPage onClose={() => {}} controller={controller} pollMs={10} tickMs={20} /></SessionContext.Provider>);
  return { ...d, controller };
}

async function click(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name });
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
}

describe('会议页里的会前', () => {
  it('待开的会列出来;点开一问一答;目的说不清只给复制、没有发送', async () => {
    const { calls } = mount([PLAN]);
    expect(screen.getByText('待开的会')).toBeTruthy();
    await click(/跟 B 客户谈下季度合作/);
    expect(screen.getByText('你那句话里说的')).toBeTruthy();
    await click('谈判会');
    expect(calls.find(c => c.path === '/meeting/answer')?.body).toEqual({ id: 'p1', question: 'kind', answer: '谈判会' });
    expect(await screen.findByText('这次会主要想定哪几件事?我好提前准备。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制这句' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送|发出去/ })).toBeNull();
  });

  it('预案卡只读:数带出处、没有的写没有;「开始录这场」带 plan_id', async () => {
    const ready: MeetingPlanView = { ...PLAN, prep: { said: 's', when: '下午三点', card_status: 'ready', card: { made_at: 'x', questions: [
      { q: '涨粉?', number: { text: '净涨粉 32', source: '小红书创作者数据' }, line: '涨了 32。', fallback: '会后补。' },
      { q: '预算?', none: true, line: '看这次谈的。', fallback: '会后补。' },
    ] } } };
    const { calls } = mount([ready]);
    await click(/跟 B 客户谈下季度合作/);
    expect(screen.getByText('出处:小红书创作者数据')).toBeTruthy();
    expect(screen.getByText('数:没有这个数')).toBeTruthy();
    await click('开始录这场');
    await waitFor(() => expect(calls.some(c => c.path === '/meeting/start')).toBe(true));
    expect((calls.find(c => c.path === '/meeting/start')?.body as { plan_id?: string }).plan_id).toBe('p1');
  });

  it('会后:登记时要定的那件事 → 问一句定下来没有,存到电脑上', async () => {
    const done: MeetingDetail = { id: 'p1', title: '谈合作', date: '2026-10-10', status: 'done', segments: 1, summary: '纪要', todos: [], unsure: [],
      prep: { said: 's', goal: { value: '敲定报价', from: 'said' }, card_status: 'ready' } };
    const { calls, controller } = mount([], desk(done));
    await act(async () => { await controller.begin('谈合作', 'p1'); await controller.finish('谈合作'); await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(await screen.findByText('这场要定「敲定报价」,定下来了吗?')).toBeTruthy();
    await click('定了一部分');
    expect(calls.find(c => c.path === '/meeting/outcome')?.body).toEqual({ id: 'p1', settled: 'partly' });
  });

  it('首页那颗会议键:有一场在等她答或者卡好了才亮点', () => {
    expect(meetingPlanNeedsLook([PLAN])).toBe(true);
    expect(meetingPlanNeedsLook([{ ...PLAN, prep: { said: 's', card_status: 'making' } }])).toBe(false);
    expect(meetingPlanNeedsLook(undefined)).toBe(false);
  });
});
