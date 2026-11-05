/**
 * 会议控制器(2026-10-09,卡「会后真机走通」)。
 *
 * 录音的生命**不挂在页面上**:来电页压上来、会议页被卸下,录音照录、分段照传;挂断回到会议页,还是同一场。
 * App 被划掉又重开:前台服务还在录就接回来;服务也没了就是「录到一半断了」,录到的段收尾传完。
 * 这里不碰真的录音器与网络:录音器、待传箱的四个口都是假的。
 */
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../src/api/client';
import { createMeetingController, type MeetingControllerDeps } from '../src/meeting/meetingController';
import { createMeetingOutbox, type MeetingOutbox, type OutboxUpload } from '../src/meeting/meetingOutbox';
import type { RecordedSegment } from '../src/meeting/meetingModel';
import type { MeetingRecording } from '../src/meeting/recorder';
import { memoryStore } from './wbchFakes';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function fakeRecording(via: 'native' | 'webview' = 'native') {
  const log: string[] = [];
  let emit: (segment: RecordedSegment) => void = () => {};
  let lastOnStop: RecordedSegment | undefined;
  const recording: MeetingRecording = {
    via,
    ...(via === 'native' ? { dir: '/files/meetings/1' } : {}),
    pause: async () => { log.push('pause'); },
    resume: async () => { log.push('resume'); },
    stop: async () => { log.push('stop'); if (lastOnStop !== undefined) emit(lastOnStop); },
    level: () => 0.3,
  };
  return {
    log,
    recording,
    bind(onSegment: (segment: RecordedSegment) => void) { emit = onSegment; },
    emit: (segment: RecordedSegment) => emit(segment),
    lastOnStop(segment: RecordedSegment) { lastOnStop = segment; },
  };
}

function world(over: Partial<MeetingControllerDeps> = {}, opts: { offline?: boolean; kv?: ReturnType<typeof memoryStore> } = {}) {
  const calls: string[] = [];
  let offline = opts.offline ?? false;
  const kv = opts.kv ?? memoryStore();
  const rec = fakeRecording();
  const saved: string[] = [];
  const outbox: MeetingOutbox = createMeetingOutbox({
    kv,
    readSegment: async path => new TextEncoder().encode(path),
    start: async (input): Promise<ApiResult<{ id: string }>> => { calls.push(`start ${input.client_key}${input.plan_id === undefined ? '' : ` plan ${input.plan_id}`}`); return offline ? { ok: false, status: 0, kind: 'network', error: '连不上' } : { ok: true, status: 200, data: { id: 'srv-1' } }; },
    upload: async (_id, segment, how): Promise<OutboxUpload> => {
      calls.push(`seg ${segment.seq}${how.viaRelay ? ' relay' : ''}`);
      return offline && !how.viaRelay ? { ok: false, offline: true, error: '在外面' } : { ok: true };
    },
    finish: async (_id, title) => { calls.push(`finish ${title}`); return offline ? { ok: false, status: 0, kind: 'network', error: '连不上' } : { ok: true, status: 200, data: {} }; },
    onChange: () => controller.sync(),
  });
  const deps: MeetingControllerDeps = {
    outbox,
    startRecording: async (input) => { rec.bind(input.onSegment); return rec.recording; },
    attachRecording: async () => null,
    ensureMic: async () => ({ granted: true }),
    saveSegment: async (key, segment) => { const path = `/data/${key}/${segment.seq}`; saved.push(path); return path; },
    listDir: async () => [],
    newKey: () => 'k1',
    now: () => Date.parse('2026-10-09T02:00:00.000Z'),
    retryEveryMs: 0,
    ...over,
  };
  const controller = createMeetingController(deps);
  return { controller, calls, rec, saved, kv, outbox, setOffline(on: boolean) { offline = on; } };
}

describe('录音的生命不挂在页面上', () => {
  it('开录 → 分段一到就记账并传 → 结束 → 电脑那边结束了 → working(带电脑编号)', async () => {
    const { controller, calls, rec } = world();
    await controller.boot();
    await controller.begin('周会');
    expect(controller.get().phase.kind).toBe('recording');
    expect(controller.active()).toBe(true);
    rec.emit({ seq: 1, path: '/files/meetings/1/01.m4a', ms: 600_000, mimeType: 'audio/mp4' });
    await tick();
    expect(calls).toEqual(['start k1', 'seg 1']);
    rec.lastOnStop({ seq: 2, path: '/files/meetings/1/02.m4a', ms: 1000, mimeType: 'audio/mp4' });
    await controller.finish('产品周会');
    expect(calls).toEqual(['start k1', 'seg 1', 'seg 2', 'finish 产品周会']);
    expect(controller.get().phase).toEqual({ kind: 'working', serverId: 'srv-1' });
    expect(controller.active()).toBe(false);
  });

  it('会前登记过的那一场(2026-10-10):开录带 plan_id,电脑把录音接到同一个会议对象上;重开 App 补开也带着', async () => {
    const kv = memoryStore();
    const { controller, calls } = world({}, { offline: true, kv });
    await controller.boot();
    await controller.begin('跟 B 客户谈', 'plan-1');
    await tick();
    expect(calls).toEqual(['start k1 plan plan-1']);
    // 出门先录着、回家补开:账里记着 plan_id
    const again = world({}, { kv });
    await again.outbox.load();
    await again.outbox.pump();
    expect(again.calls[0]).toBe('start k1 plan plan-1');
  });

  it('暂停 / 继续:计时扣掉暂停那一段', async () => {
    let now = Date.parse('2026-10-09T02:00:00.000Z');
    const { controller, rec } = world({ now: () => now });
    await controller.boot();
    await controller.begin('');
    now += 60_000;
    await controller.pause();
    expect(controller.get().phase.kind).toBe('paused');
    now += 30_000;
    expect(controller.elapsed()).toBe(60_000);
    await controller.resume();
    now += 10_000;
    expect(controller.elapsed()).toBe(70_000);
    expect(rec.log).toEqual(['pause', 'resume']);
  });

  it('WebView 退路给的是字节:先写成文件再记账;「结束」等最后那一段写完才收尾', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { controller, calls, rec, saved } = world({
      saveSegment: async (key, segment) => { await gate; const path = `/data/${key}/${segment.seq}`; saved.push(path); return path; },
    });
    await controller.boot();
    await controller.begin('');
    rec.lastOnStop({ seq: 1, bytes: new Uint8Array([1, 2]), ms: 1000, mimeType: 'audio/webm' });
    const finishing = controller.finish('');
    await tick();
    expect(calls.filter(c => c.startsWith('finish'))).toHaveLength(0);
    release();
    await finishing;
    expect(saved).toEqual(['/data/k1/1']);
    expect(calls).toContain('seg 1');
    expect(calls[calls.length - 1]).toBe('finish ');
  });
});

describe('出门', () => {
  it('在外面:攒着,标 offline;她点「现在经服务器传」之后这一场走中转', async () => {
    const { controller, rec } = world({}, { offline: true });
    await controller.boot();
    await controller.begin('');
    rec.emit({ seq: 1, path: '/p/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await tick();
    expect(controller.get().upload).toMatchObject({ pending: 1, offline: true, viaRelay: false });
    await controller.allowRelay();
    await tick();
    // 开场还连不上(start 走房间代理,这里假的一并当作连不上),所以分段还没走;start 通了之后走中转。
    expect(controller.get().upload.viaRelay).toBe(true);
  });

  it('开场连不上不拦录音:照录,一句话说清录音在手机上', async () => {
    const { controller } = world({}, { offline: true });
    await controller.boot();
    await controller.begin('');
    await tick();
    expect(controller.get().phase.kind).toBe('recording');
  });

  it('电脑那边开不了(没配工作目录):原话摆出来,录音照录', async () => {
    const holder: { sync?: () => void } = {};
    const { controller } = world({
      outbox: createMeetingOutbox({
        kv: memoryStore(),
        readSegment: async () => new Uint8Array(),
        start: async () => ({ ok: false, status: 409, kind: 'http', error: '还没配「工作目录」' }),
        upload: async () => ({ ok: true }),
        finish: async () => ({ ok: true, status: 200, data: {} }),
        onChange: () => holder.sync?.(),
      }),
    });
    holder.sync = () => controller.sync();
    await controller.boot();
    await controller.begin('');
    await tick();
    expect(controller.get().phase.kind).toBe('recording');
    expect(controller.get().upload.error).toBe('还没配「工作目录」');
  });
});

describe('App 被划掉 / 被杀又重开', () => {
  it('前台服务还在录:接回同一场(同一个编号、同一个开录时刻),补认重开前录完却没报上来的段', async () => {
    const kv = memoryStore();
    const first = world({}, { kv });
    await first.controller.boot();
    await first.controller.begin('周会');
    first.rec.emit({ seq: 1, path: '/files/meetings/1/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await tick();

    const live = fakeRecording();
    const second = world({
      attachRecording: async (input) => { live.bind(input.onSegment); return { recording: live.recording, status: { paused: false, seq: 4, dir: '/files/meetings/1' } }; },
      listDir: async () => ['01.m4a', '02.m4a', '03.m4a', '04.m4a'],
      newKey: () => 'k-should-not-be-used',
    }, { kv });
    await second.controller.boot();
    expect(second.controller.get().phase.kind).toBe('recording');
    expect(second.controller.get().key).toBe('k1');
    expect(second.controller.get().title).toBe('周会');
    await tick();
    // 02、03 是重开前录完的(04 还在录,不碰);01 已经传过了,不再传。
    expect(second.calls).toEqual(['seg 2', 'seg 3']);
  });

  it('服务也没了:「录到一半断了」;收尾 = 把录到的传完再整理', async () => {
    const kv = memoryStore();
    const first = world({}, { kv });
    await first.controller.boot();
    await first.controller.begin('周会');
    first.rec.emit({ seq: 1, path: '/files/meetings/1/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await tick();

    const second = world({ listDir: async () => ['01.m4a', '02.m4a'] }, { kv });
    await second.controller.boot();
    expect(second.controller.get().phase.kind).toBe('interrupted');
    expect(second.controller.active()).toBe(true);
    await second.controller.finish('周会');
    expect(second.calls).toEqual(['seg 2', 'finish 周会']);
    expect(second.controller.get().phase).toEqual({ kind: 'working', serverId: 'srv-1' });
  });

  it('按过「结束」但还没传完:重开就接着传,传完进 working', async () => {
    const kv = memoryStore();
    const first = world({}, { kv, offline: true });
    await first.controller.boot();
    await first.controller.begin('周会');
    first.rec.lastOnStop({ seq: 1, path: '/p/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await first.controller.finish('周会');
    expect(first.controller.get().phase.kind).toBe('uploading');

    const second = world({}, { kv });
    await second.controller.boot();
    await tick();
    expect(second.controller.get().phase).toEqual({ kind: 'working', serverId: 'srv-1' });
  });
});

describe('起不来', () => {
  it('没有录音权限:failed + 「去设置里打开」那颗', async () => {
    const { controller } = world({ ensureMic: async () => ({ granted: false, needsSettings: true, error: '被拒绝' }) });
    await controller.boot();
    await controller.begin('');
    expect(controller.get().phase).toMatchObject({ kind: 'failed', micFix: true });
  });

  it('录音器起不来:failed,不在待传箱里留一场空会', async () => {
    const { controller, calls } = world({ startRecording: async () => null });
    await controller.boot();
    await controller.begin('');
    await tick();
    expect(controller.get().phase.kind).toBe('failed');
    expect(calls).toEqual([]);
  });
});
