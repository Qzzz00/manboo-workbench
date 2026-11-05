/**
 * 会议页的假手机端到端(2026-09-21)。
 *
 * 真的录音器不进来(MediaRecorder / 原生前台服务都注入假的),8791 也是假的 —— 这份用例盯的是
 * **这一页把事情按什么顺序做**:先问权限 → 开一场 → 分段传上去 → 结束 → 正在整理 → 纪要与待办。
 * 真的转写与真的模型在电脑那一侧,有它们自己的用例(workbench-plugin/tests/server-meeting*.test.ts)。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingPage } from '../src/meeting/MeetingPage';
import { SessionContext, type Session } from '../src/session';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import type { RecordedSegment } from '../src/meeting/meetingModel';
import { MEETING_RELAY_LABEL } from '../src/meeting/meetingModel';
import { MEETING_AWAY_TEXT, type MeetingDetail } from '../src/meeting/meetingApi';
import type { MeetingController } from '../src/meeting/meetingController';
import type { WbchMode } from '../src/channel/channelProtocol';
import { testMeetingController } from './meetingFakes';

const DETAIL_DONE: MeetingDetail = {
  id: 'm1',
  title: '产品周会',
  date: '2026-09-21',
  status: 'done',
  segments: 2,
  seconds: 1200,
  dir: '/Users/example/repo/会议/2026-09-21-产品周会',
  summary: '# 产品周会 · 纪要\n\n## 结论\n\n- 先做会议模式\n',
  todos: [
    { id: 't1', what: '把转写跑一遍', who: '小王', due: '这周五前' },
    { id: 't2', what: '写一份交接' },
  ],
  unsure: ['「那个接口」没听清'],
};

interface FakeDeskOptions {
  /** `/meeting/segment` 前几次失败(network = 出了局域网;http = 电脑那边没收下)。 */
  failSegments?: number;
  failKind?: 'network' | 'http';
  /** 轮询时先回几次「还在转写」。 */
  workingRounds?: number;
  startFails?: string;
  /** 整理先失败一次(能重新来)。 */
  failFirst?: boolean;
  /** 选路那边此刻在哪(出门 = remote)。 */
  mode?: WbchMode;
}

function fakeDesk(options: FakeDeskOptions = {}) {
  const segments: { seq: number; ms: number; mime: string; bytes: number; via: string }[] = [];
  const calls: string[] = [];
  let applied: string[][] = [];
  let left = options.failSegments ?? 0;
  let rounds = options.workingRounds ?? 0;
  let failOnce = options.failFirst === true;
  let detail: MeetingDetail = { ...DETAIL_DONE, status: 'transcribing', transcribed: 0 };
  let mode: WbchMode = options.mode ?? 'direct';

  function handler(via: string) {
    return async function json<T>(path: string, init: RequestOptions = {}): Promise<ApiResult<T>> {
      calls.push(`${init.method ?? 'GET'} ${path.split('?')[0]}`);
      if (path === '/meeting/start') {
        if (options.startFails !== undefined) return { ok: false, status: 409, kind: 'http', error: options.startFails };
        return { ok: true, status: 200, data: { ok: true, id: 'm1', dir: DETAIL_DONE.dir } as T };
      }
      if (path.startsWith('/meeting/segment')) {
        if (left > 0 && via === 'direct') {
          left -= 1;
          return options.failKind === 'http'
            ? { ok: false, status: 400, kind: 'http', error: '这一段没写进硬盘' }
            : { ok: false, status: 0, kind: 'network', error: '连不上工作台' };
        }
        const query = new URLSearchParams(path.split('?')[1] ?? '');
        const blob = init.body as Blob;
        segments.push({ seq: Number(query.get('seq')), ms: Number(query.get('ms')), mime: init.headers?.['content-type'] ?? '', bytes: blob.size, via });
        return { ok: true, status: 200, data: { ok: true } as T };
      }
      if (path === '/meeting/finish') return { ok: true, status: 200, data: { ok: true } as T };
      if (path === '/meeting/retry') { detail = { ...DETAIL_DONE, status: 'summarizing' }; return { ok: true, status: 200, data: { ok: true } as T }; }
      if (path.startsWith('/meeting?')) {
        if (rounds > 0) { rounds -= 1; return { ok: true, status: 200, data: detail as T }; }
        if (failOnce) { failOnce = false; detail = { ...DETAIL_DONE, status: 'failed', error: '转写没接上(8792 没起来)', retryable: true }; return { ok: true, status: 200, data: detail as T }; }
        if (detail.status !== 'done' && detail.status !== 'failed') detail = DETAIL_DONE;
        return { ok: true, status: 200, data: detail as T };
      }
      if (path === '/meeting/apply') {
        const body = init.body as { todos?: string[] };
        const wanted = body.todos ?? DETAIL_DONE.todos.map(t => t.id);
        applied = [...applied, wanted];
        detail = { ...DETAIL_DONE, todos: DETAIL_DONE.todos.map(t => (wanted.includes(t.id) ? { ...t, task_id: `task-${t.id}` } : t)) };
        return { ok: true, status: 200, data: { ok: true, created: wanted.map(id => `task-${id}`) } as T };
      }
      return { ok: false, status: 404, kind: 'http', error: `没有这条路由:${path}` };
    };
  }
  const blob = async (): Promise<ApiResult<Blob>> => ({ ok: false, status: 404, kind: 'http', error: '用不到' });
  const direct = { baseUrl: 'http://127.0.0.1:8791', json: handler('direct'), blob } as ApiClient;
  const routed = { baseUrl: 'http://127.0.0.1:8791', json: handler('routed'), blob, mode: () => mode } as ApiClient & { mode: () => WbchMode };

  return { direct, routed, segments, calls, applied: () => applied, stopFailing() { left = 0; }, setMode(next: WbchMode) { mode = next; } };
}

/** 假录音器(原生那条):测试自己决定什么时候吐一段。 */
function fakeRecorder() {
  let emit: ((segment: RecordedSegment) => void) | undefined;
  const log: string[] = [];
  const plugin = {
    start: async () => { log.push('start'); return { dir: '/files/meetings/1' }; },
    status: async () => ({ recording: false }),
    pause: async () => { log.push('pause'); },
    resume: async () => { log.push('resume'); },
    stop: async () => { log.push('stop'); },
    level: async () => ({ level: 0.4 }),
    addListener: async (event: string, handler: (data: Record<string, unknown>) => void) => {
      if (event === 'segment') {
        emit = (segment) => handler({ seq: segment.seq, path: `/files/meetings/1/${segment.seq}.m4a`, ms: segment.ms, mimeType: segment.mimeType });
      }
      return { remove: async () => {} };
    },
  };
  return {
    log,
    // stopGraceMs 调小:生产是 1.5 秒(等最后一段过桥),用例里不用真等。
    deps: { native: plugin as never, stopGraceMs: 10 },
    async emitSegment(seq: number, ms = 600_000) {
      await act(async () => {
        emit?.({ seq, mimeType: 'audio/mp4', ms });
        await new Promise(resolve => setTimeout(resolve, 20));
      });
    },
  };
}

function controllerFor(desk: ReturnType<typeof fakeDesk>, recorder: ReturnType<typeof fakeRecorder>): MeetingController {
  return testMeetingController({ direct: desk.direct, routed: desk.routed, recorderDeps: recorder.deps, segmentMs: 60_000 });
}

function page(desk: ReturnType<typeof fakeDesk>, controller: MeetingController, onClose = () => {}) {
  const session = { direct: desk.direct, client: desk.routed } as unknown as Session;
  return (
    <SessionContext.Provider value={session}>
      <MeetingPage onClose={onClose} controller={controller} segmentMs={60_000} pollMs={10} tickMs={20} />
    </SessionContext.Provider>
  );
}

function mount(desk: ReturnType<typeof fakeDesk>, recorder: ReturnType<typeof fakeRecorder>, onClose = () => {}) {
  const controller = controllerFor(desk, recorder);
  return { controller, ...render(page(desk, controller, onClose)) };
}

async function clickText(text: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name: text });
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 60)); });
}

describe('会议页:一整条(开始录 → 两段 → 结束 → 正在整理 → 纪要与待办)', () => {
  it('走得通,而且每一步说的话都对', async () => {
    const desk = fakeDesk({ workingRounds: 20 });
    const recorder = fakeRecorder();
    mount(desk, recorder);

    // 一进来是等着开始,并且**先说清录音不出这两台设备**
    expect(screen.getByText(/录音默认只在这台手机和你的电脑之间走/)).toBeTruthy();
    await clickText('开始录');

    // 原生那条接上了 → 说「屏幕可以关」
    expect(recorder.log).toContain('start');
    expect(screen.getByText(/屏幕可以关/)).toBeTruthy();
    expect(screen.getByLabelText('已经录了').textContent).toMatch(/^\d\d:\d\d:\d\d$/);

    await recorder.emitSegment(1);
    await recorder.emitSegment(2, 120_000);
    await waitFor(() => { expect(desk.segments).toHaveLength(2); });
    expect(desk.segments.map(s => s.seq)).toEqual([1, 2]);
    expect(desk.segments[0]?.ms).toBe(600_000);
    expect(desk.segments[0]?.mime).toBe('audio/mp4');
    expect(desk.segments[0]?.bytes).toBe(4);

    await clickText('结束');
    expect(recorder.log).toContain('stop');
    // 「正在整理」+ 一句「可以先离开」
    await waitFor(() => { expect(screen.getByText(/可以先去忙别的/)).toBeTruthy(); });

    // 轮询到 done → 纪要 + 两条待办
    await waitFor(() => { expect(screen.getByText(/产品周会 · 纪要/)).toBeTruthy(); }, { timeout: 2000 });
    expect(screen.getByText('把转写跑一遍')).toBeTruthy();
    expect(screen.getByText('小王')).toBeTruthy();
    expect(screen.getByText('这周五前')).toBeTruthy();
    // 没说谁的那条**明写「没说谁」**,不留空
    expect(screen.getByText('没说谁')).toBeTruthy();
    expect(screen.getByText('「那个接口」没听清')).toBeTruthy();
    expect(screen.getByText(new RegExp(DETAIL_DONE.dir ?? ''))).toBeTruthy();

    await clickText('都建');
    await waitFor(() => { expect(desk.applied()[0]).toEqual(['t1', 't2']); });
    await waitFor(() => { expect(screen.getAllByText('已建')).toHaveLength(2); });
  });

  it('逐条勾:只建勾中的那条', async () => {
    const desk = fakeDesk();
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await recorder.emitSegment(1);
    await clickText('结束');
    await waitFor(() => { expect(screen.getByText('写一份交接')).toBeTruthy(); }, { timeout: 2000 });

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    await act(async () => { boxes[1]?.click(); await new Promise(resolve => setTimeout(resolve, 5)); });
    await clickText(/建选中的 1 条/);
    await waitFor(() => { expect(desk.applied()[0]).toEqual(['t2']); });
  });

  it('**录着的时候不放别的出口**:顶上那颗「返回」不见了,要走只有「结束」', async () => {
    const desk = fakeDesk();
    const recorder = fakeRecorder();
    mount(desk, recorder);
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
    await clickText('开始录');
    expect(screen.queryByRole('button', { name: '返回' })).toBeNull();
    expect(screen.getByRole('button', { name: '结束' })).toBeTruthy();
    // 暂停着也一样:暂停不是"离开"
    await clickText('暂停');
    expect(screen.queryByRole('button', { name: '返回' })).toBeNull();
  });

  it('暂停 / 继续', async () => {
    const desk = fakeDesk();
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await clickText('暂停');
    expect(screen.getByText('暂停中,没有在录')).toBeTruthy();
    expect(recorder.log).toContain('pause');
    await clickText('继续');
    expect(recorder.log).toContain('resume');
  });
});

describe('来电压上来(2026-10-09):录音的生命不挂在页面上', () => {
  it('★会议页被卸下(来电页顶上来),录音不停、分段照传;挂断回来还是同一场', async () => {
    const desk = fakeDesk();
    const recorder = fakeRecorder();
    const { controller, unmount } = mount(desk, recorder);
    await clickText('开始录');
    unmount();
    // 来电那一阵:页面不在,录音器没被停,段照样记账、照样传上去。
    expect(recorder.log).not.toContain('stop');
    expect(controller.active()).toBe(true);
    await recorder.emitSegment(1);
    await waitFor(() => { expect(desk.segments.map(s => s.seq)).toEqual([1]); });
    // 挂断:Shell 看 active() 回到会议页 —— 同一个控制器,还在录。
    render(page(desk, controller));
    expect(screen.getByRole('button', { name: '结束' })).toBeTruthy();
    expect(screen.getByText(/已经传上去 1 段/)).toBeTruthy();
    await clickText('结束');
    await waitFor(() => { expect(desk.calls).toContain('POST /meeting/finish'); });
  });
});

describe('出门(2026-10-09)', () => {
  it('在外面:分段不发,说清先存在手机上;点「现在经中转服务器传」之后这一场经选好路的那个传', async () => {
    const desk = fakeDesk({ mode: 'remote' });
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await recorder.emitSegment(1);
    await waitFor(() => { expect(screen.getByText(MEETING_AWAY_TEXT)).toBeTruthy(); });
    expect(desk.segments).toHaveLength(0);
    await clickText(MEETING_RELAY_LABEL);
    await waitFor(() => { expect(desk.segments).toEqual([expect.objectContaining({ seq: 1, via: 'routed' })]); });
  });
});

describe('整理没成(2026-10-09)', () => {
  it('转写失败 → 一颗「重新整理」→ POST /meeting/retry → 回到正在整理 → 纪要', async () => {
    const desk = fakeDesk({ failFirst: true });
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await recorder.emitSegment(1);
    await clickText('结束');
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('转写没接上'); });
    expect(screen.getByText(/都还在.*没有删/)).toBeTruthy();
    await clickText('重新整理');
    expect(desk.calls).toContain('POST /meeting/retry');
    await waitFor(() => { expect(screen.getByText(/产品周会 · 纪要/)).toBeTruthy(); }, { timeout: 2000 });
  });
});

describe('传不上去的时候', () => {
  it('**不结束**:出了局域网,点了「结束」停在上传那一屏,说清在手机上;回到局域网「重试」就传完再收尾', async () => {
    const desk = fakeDesk({ failSegments: 99 });
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await recorder.emitSegment(1);
    await clickText('结束');

    await waitFor(() => { expect(screen.getByText(/还有 1 段/)).toBeTruthy(); });
    expect(screen.getByText(MEETING_AWAY_TEXT)).toBeTruthy();
    // finish 一次都没发出去 —— 电脑那边不该按残缺的录音去转写
    expect(desk.calls.filter(one => one === 'POST /meeting/finish')).toHaveLength(0);

    desk.stopFailing();
    await clickText('重试');
    await waitFor(() => { expect(desk.segments).toHaveLength(1); });
    await waitFor(() => { expect(desk.calls).toContain('POST /meeting/finish'); });
  });

  it('电脑那边没收下(不是网的事):原话摆出来,不说「在外面」', async () => {
    const desk = fakeDesk({ failSegments: 99, failKind: 'http' });
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await recorder.emitSegment(1);
    await waitFor(() => { expect(screen.getByText(/这一段没写进硬盘/)).toBeTruthy(); });
    expect(screen.queryByText(MEETING_AWAY_TEXT)).toBeNull();
  });
});

describe('开不了的时候', () => {
  it('工作台说没配工作目录 → 原样转达那句话,**录音照录**(录音在手机上,配好之后自己补开、补传)', async () => {
    const desk = fakeDesk({ startFails: '还没配「工作目录」(事务官仓库),会议没地方落。' });
    const recorder = fakeRecorder();
    mount(desk, recorder);
    await clickText('开始录');
    await waitFor(() => { expect(screen.getByText(/还没配「工作目录」/)).toBeTruthy(); });
    expect(recorder.log).toContain('start');
    expect(screen.getByRole('button', { name: '结束' })).toBeTruthy();
  });

  it('没有录音权限 → 说清后果 + 一颗「去设置里打开」', async () => {
    const desk = fakeDesk();
    const recorder = fakeRecorder();
    const controller = testMeetingController({
      direct: desk.direct,
      recorderDeps: recorder.deps,
      micDeps: { native: { check: async () => ({ granted: false, state: 'denied' }), request: async () => ({ granted: false, state: 'denied' }), openSettings: async () => {} } },
    });
    render(page(desk, controller));
    await clickText('开始录');
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('没有录音权限'); });
    expect(screen.getByRole('button', { name: '去设置里打开' })).toBeTruthy();
    expect(recorder.log).not.toContain('start');
  });

  it('原生那条没接上 → 退回 WebView,并把「别锁屏」那句话摆出来', async () => {
    const desk = fakeDesk();
    const controller = testMeetingController({
      direct: desk.direct,
      recorderDeps: {
        native: null,
        getUserMedia: async () => ({ getTracks: () => [] } as unknown as MediaStream),
        mediaRecorder: class {
          static isTypeSupported(): boolean { return true; }
          state = 'inactive';
          ondataavailable: unknown = null;
          onstop: unknown = null;
          onerror: unknown = null;
          start(): void {}
          stop(): void {}
        } as unknown as typeof MediaRecorder,
        audioContext: null,
      },
    });
    render(page(desk, controller));
    await clickText('开始录');
    await waitFor(() => { expect(screen.getByText(/锁屏会停/)).toBeTruthy(); });
  });
});
