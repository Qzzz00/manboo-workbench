/**
 * 会议的「待传箱」(2026-10-09,卡「会后真机走通」)。
 *
 * 分段先落在手机上(原生那条本来就落在 App 的文件目录里;WebView 退路由上层写成文件),
 * 这里只记「哪一场、哪几段、传了没有」,而且**记在 Preferences 里**:App 被杀、重开之后接着传。
 * 在家直连;出门默认不传(攒着),她这一场点了「现在经服务器传」才走中转 —— 走哪条由 upload 那一头定,
 * 这里只把「这一场准不准走中转」带过去。
 */
import { describe, expect, it } from 'vitest';
import { createMeetingOutbox, MEETING_OUTBOX_KEY, type MeetingOutboxDeps, type OutboxUpload } from '../src/meeting/meetingOutbox';
import { memoryStore } from './wbchFakes';

function desk(over: Partial<MeetingOutboxDeps> = {}) {
  const calls: string[] = [];
  let offline = false;
  const deps: MeetingOutboxDeps = {
    kv: memoryStore(),
    readSegment: async path => new TextEncoder().encode(path),
    start: async (input) => { calls.push(`start ${input.title} ${input.client_key} ${input.started_at}`); return offline ? { ok: false, status: 0, kind: 'network', error: '连不上' } : { ok: true, status: 200, data: { ok: true, id: 'srv-1' } }; },
    upload: async (serverId, segment, how): Promise<OutboxUpload> => {
      calls.push(`seg ${serverId} ${segment.seq} ${segment.bytes.length}${how.viaRelay ? ' relay' : ''}`);
      return offline && !how.viaRelay ? { ok: false, error: '在外面', offline: true } : { ok: true };
    },
    finish: async (serverId, title) => { calls.push(`finish ${serverId} ${title}`); return offline ? { ok: false, status: 0, kind: 'network', error: '连不上' } : { ok: true, status: 200, data: { ok: true } }; },
    ...over,
  };
  return { deps, calls, setOffline(on: boolean) { offline = on; } };
}

const BEGIN = { key: 'k1', title: '周会', startedAt: '2026-10-09T02:00:00.000Z' };

describe('在家:开一场 → 分段按顺序传 → 结束', () => {
  it('补开时带 client_key 与开录时刻;分段按 seq 传;结束后才 finish,然后这一场算传完', async () => {
    const { deps, calls } = desk();
    const box = createMeetingOutbox(deps);
    await box.load();
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 2, path: '/m/02.m4a', ms: 600_000, mimeType: 'audio/mp4' });
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 600_000, mimeType: 'audio/mp4' });
    await box.pump();
    expect(calls).toEqual(['start 周会 k1 2026-10-09T02:00:00.000Z', 'seg srv-1 1 9', 'seg srv-1 2 9']);
    expect(box.view('k1')).toMatchObject({ pending: 0, sent: 2, serverId: 'srv-1', finished: false });
    await box.end('k1', '产品周会');
    await box.pump();
    expect(calls[calls.length - 1]).toBe('finish srv-1 产品周会');
    expect(box.view('k1')).toMatchObject({ finished: true });
  });

  it('同时叫两次 pump 只跑一遍(不开两场、不传两遍)', async () => {
    const { deps, calls } = desk();
    const box = createMeetingOutbox(deps);
    await box.load();
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await Promise.all([box.pump(), box.pump()]);
    expect(calls.filter(c => c.startsWith('start'))).toHaveLength(1);
    expect(calls.filter(c => c.startsWith('seg'))).toHaveLength(1);
  });
});

describe('出门:攒着,不丢', () => {
  it('在外面没点过「经服务器传」:一段都不送,标成 offline;回家后接着传', async () => {
    const { deps, calls, setOffline } = desk();
    const box = createMeetingOutbox(deps);
    await box.load();
    setOffline(true);
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.pump();
    expect(box.view('k1')).toMatchObject({ pending: 1, sent: 0, offline: true });
    expect(calls.filter(c => c.startsWith('seg'))).toHaveLength(0);
    setOffline(false);
    await box.pump();
    expect(box.view('k1')).toMatchObject({ pending: 0, sent: 1, offline: false });
  });

  it('**App 被杀、重开**:新的一个从 Preferences 读回来,没传的接着传,传过的不再传', async () => {
    const { deps, calls } = desk();
    const first = createMeetingOutbox(deps);
    await first.load();
    await first.begin(BEGIN);
    await first.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await first.pump();
    await first.addSegment('k1', { seq: 2, path: '/m/02.m4a', ms: 1, mimeType: 'audio/mp4' });
    // 第 2 段还没传,App 被杀了。
    expect(await deps.kv.get(MEETING_OUTBOX_KEY)).toContain('/m/02.m4a');
    const second = createMeetingOutbox(deps);
    await second.load();
    calls.length = 0;
    await second.pump();
    expect(calls).toEqual(['seg srv-1 2 9']);
  });

  it('这一场点了「现在经服务器传」:之后的段带着 viaRelay 去传,而且记下来(重开也算数)', async () => {
    const { deps, calls, setOffline } = desk({ start: async () => ({ ok: true, status: 200, data: { ok: true, id: 'srv-1' } }) });
    const box = createMeetingOutbox(deps);
    await box.load();
    setOffline(true);
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.pump();
    expect(box.view('k1')?.pending).toBe(1);
    await box.allowRelay('k1');
    await box.pump();
    expect(calls[calls.length - 1]).toBe('seg srv-1 1 9 relay');
    expect(box.view('k1')).toMatchObject({ pending: 0, viaRelay: true });
    const again = createMeetingOutbox(deps);
    await again.load();
    expect(again.view('k1')?.viaRelay).toBe(true);
  });
});

describe('失败也不越过、不丢', () => {
  it('一段传不上:后面的不越过它(电脑靠 seq 拼时间戳),原话留着', async () => {
    let failSeq: number | undefined = 1;
    const { deps, calls } = desk({
      upload: async (_id, segment) => { calls.push(`seg ${segment.seq}`); return segment.seq === failSeq ? { ok: false, error: '这一段没写进硬盘' } : { ok: true }; },
    });
    const box = createMeetingOutbox(deps);
    await box.load();
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.addSegment('k1', { seq: 2, path: '/m/02.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.pump();
    expect(calls.filter(c => c.startsWith('seg'))).toEqual(['seg 1']);
    expect(box.view('k1')).toMatchObject({ pending: 2, error: '这一段没写进硬盘', offline: false });
    failSeq = undefined;
    await box.pump();
    expect(box.view('k1')).toMatchObject({ pending: 0 });
  });

  it('电脑那边开不了(没配工作目录):原话留着,一段都不送;配好之后再 pump 就开上了', async () => {
    let refuse = true;
    const { deps, calls } = desk({
      start: async () => (refuse ? { ok: false, status: 409, kind: 'http', error: '还没配「工作目录」' } : { ok: true, status: 200, data: { ok: true, id: 'srv-1' } }),
    });
    const box = createMeetingOutbox(deps);
    await box.load();
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.pump();
    expect(box.view('k1')).toMatchObject({ error: '还没配「工作目录」', pending: 1 });
    expect(calls).toHaveLength(0);
    refuse = false;
    await box.pump();
    expect(box.view('k1')).toMatchObject({ pending: 0, serverId: 'srv-1' });
  });

  it('文件读不回来:说清「文件还在手机上」,不当成传过了', async () => {
    const { deps } = desk({ readSegment: async () => { throw new Error('ENOENT'); } });
    const box = createMeetingOutbox(deps);
    await box.load();
    await box.begin(BEGIN);
    await box.addSegment('k1', { seq: 1, path: '/m/01.m4a', ms: 1, mimeType: 'audio/mp4' });
    await box.pump();
    expect(box.view('k1')?.pending).toBe(1);
    expect(box.view('k1')?.error).toContain('第 1 段');
  });

  it('传完的老会只留最近几场(箱子不越攒越大);没传完的一场都不丢', async () => {
    const { deps } = desk();
    const box = createMeetingOutbox(deps);
    await box.load();
    for (let i = 1; i <= 6; i += 1) {
      await box.begin({ ...BEGIN, key: `k${i}` });
      await box.end(`k${i}`, '会');
      await box.pump();
    }
    await box.begin({ ...BEGIN, key: 'k7' });
    expect(box.view('k1')).toBeUndefined();
    expect(box.view('k6')?.finished).toBe(true);
    expect(box.view('k7')?.finished).toBe(false);
  });
});
