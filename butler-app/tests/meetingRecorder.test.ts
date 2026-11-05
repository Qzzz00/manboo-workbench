import { describe, expect, it } from 'vitest';
import { attachMeetingRecording, pickMeetingMimeType, startMeetingRecording } from '../src/meeting/recorder';
import type { RecordedSegment } from '../src/meeting/meetingModel';

/** 一个够用的假 MediaRecorder:start/stop 各自触发一次 ondataavailable + onstop。 */
class FakeRecorder {
  static supported = ['audio/mp4'];
  static isTypeSupported(type: string): boolean { return FakeRecorder.supported.includes(type); }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static made = 0;
  constructor(_stream: unknown, public options?: { mimeType?: string }) { FakeRecorder.made += 1; }
  start(): void { this.state = 'recording'; }
  pause(): void { this.state = 'paused'; }
  resume(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.options?.mimeType ?? 'audio/mp4' }) });
    this.onstop?.();
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

function webDeps() {
  return {
    native: null,
    getUserMedia: async () => fakeStream(),
    mediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    audioContext: null,
  };
}

describe('选格式', () => {
  it('优先 mp4(macOS 自带的 afconvert 解得开它,webm 只有 ffmpeg 解得开)', () => {
    expect(pickMeetingMimeType({ isTypeSupported: t => t === 'audio/mp4' || t === 'audio/webm' })).toBe('audio/mp4');
    expect(pickMeetingMimeType({ isTypeSupported: t => t === 'audio/webm' })).toBe('audio/webm');
    expect(pickMeetingMimeType({ isTypeSupported: () => false })).toBeUndefined();
    expect(pickMeetingMimeType(undefined)).toBeUndefined();
  });

  it('实现对没见过的串抛异常也不会把整个挑选弄挂', () => {
    expect(pickMeetingMimeType({ isTypeSupported: () => { throw new Error('nope'); } })).toBeUndefined();
  });
});

describe('原生那条(前台服务)', () => {
  function nativeStub() {
    const listeners: Record<string, ((data: Record<string, unknown>) => void)[]> = {};
    const calls: string[] = [];
    return {
      calls,
      emit(event: string, data: Record<string, unknown>) { for (const fn of listeners[event] ?? []) fn(data); },
      plugin: {
        start: async () => { calls.push('start'); return { dir: '/files/meetings/1700000000000' }; },
        status: async () => ({ recording: false }),
        pause: async () => { calls.push('pause'); },
        resume: async () => { calls.push('resume'); },
        stop: async () => { calls.push('stop'); },
        level: async () => ({ level: 0.5 }),
        addListener: async (event: string, handler: (data: Record<string, unknown>) => void) => {
          (listeners[event] ??= []).push(handler);
          return { remove: async () => {} };
        },
      },
    };
  }

  it('接得上就走它,via=native(界面据此说「屏幕可以关」)', async () => {
    const stub = nativeStub();
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: () => {} },
      { native: stub.plugin as never },
    );
    expect(recording?.via).toBe('native');
    // 原生落盘的目录要交出来:待传箱记着它,App 重开时据此补认没报上来的段。
    expect(recording?.dir).toBe('/files/meetings/1700000000000');
    expect(stub.calls).toContain('start');
    await recording?.pause();
    await recording?.resume();
    await recording?.stop();
    expect(stub.calls).toEqual(['start', 'pause', 'resume', 'stop']);
  });

  it('**stop() 要等到最后那一段真交到手里才返回** —— 不等就会"结束之后少了最后十分钟"', async () => {
    const stub = nativeStub();
    const got: RecordedSegment[] = [];
    const recording = await startMeetingRecording(
      { onSegment: s => got.push(s), onError: () => {} },
      { native: stub.plugin as never, stopGraceMs: 500 },
    );
    // 假装 stop 那一下原生过了一会儿才把最后一段推过来
    setTimeout(() => { stub.emit('segment', { seq: 3, path: '/x/03.m4a', ms: 5000 }); }, 40);
    await recording?.stop();
    // stop() 返回的那一刻,最后一段已经在手里了
    expect(got.map(s => s.seq)).toEqual([3]);
  });

  it('最后一段一直没来:等满宽限就走,不把「结束」永远卡住', async () => {
    const stub = nativeStub();
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: () => {} },
      { native: stub.plugin as never, stopGraceMs: 80 },
    );
    const at = Date.now();
    await recording?.stop();
    const waited = Date.now() - at;
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThan(1000);
  });

  it('原生吐一段 → 带着路径交出来,**不当场读进内存**(几 MB 一段,待传箱要传时才读)', async () => {
    const stub = nativeStub();
    const got: RecordedSegment[] = [];
    await startMeetingRecording({ onSegment: s => got.push(s), onError: () => {} }, { native: stub.plugin as never });
    stub.emit('segment', { seq: 1, path: '/files/meetings/x/01.m4a', ms: 600_000, mimeType: 'audio/mp4' });
    expect(got).toEqual([{ seq: 1, path: '/files/meetings/x/01.m4a', mimeType: 'audio/mp4', ms: 600_000 }]);
  });

  it('原生插件没登记上(调它就抛)→ **退回 WebView 那条**,不在这儿放弃', async () => {
    const broken = {
      start: async () => { throw new Error('没这个实现'); },
      pause: async () => {}, resume: async () => {}, stop: async () => {},
      level: async () => ({}),
      addListener: async () => ({ remove: async () => {} }),
    };
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: () => {} },
      { ...webDeps(), native: broken as never },
    );
    expect(recording?.via).toBe('webview');
    await recording?.stop();
  });
});

describe('App 重开时接回还在录的前台服务(2026-10-09)', () => {
  function liveStub(status: Record<string, unknown> | Error) {
    const listeners: Record<string, ((data: Record<string, unknown>) => void)[]> = {};
    const calls: string[] = [];
    return {
      calls,
      emit(event: string, data: Record<string, unknown>) { for (const fn of listeners[event] ?? []) fn(data); },
      plugin: {
        start: async () => { calls.push('start'); return {}; },
        status: async () => { if (status instanceof Error) throw status; return status; },
        pause: async () => { calls.push('pause'); },
        resume: async () => { calls.push('resume'); },
        stop: async () => { calls.push('stop'); },
        level: async () => ({ level: 0.2 }),
        addListener: async (event: string, handler: (data: Record<string, unknown>) => void) => {
          (listeners[event] ??= []).push(handler);
          return { remove: async () => {} };
        },
      },
    };
  }

  it('服务还在录:接上监听(不再 start 一遍),报暂停没有、录到第几段、目录;之后的段照常交出来', async () => {
    const stub = liveStub({ recording: true, paused: true, seq: 3, dir: '/files/meetings/1' });
    const got: RecordedSegment[] = [];
    const attached = await attachMeetingRecording({ onSegment: s => got.push(s), onError: () => {} }, { native: stub.plugin as never });
    expect(attached?.recording.via).toBe('native');
    expect(attached?.status).toEqual({ paused: true, seq: 3, dir: '/files/meetings/1' });
    expect(stub.calls).not.toContain('start');
    stub.emit('segment', { seq: 4, path: '/files/meetings/1/04.m4a', ms: 1000, mimeType: 'audio/mp4' });
    expect(got.map(s => s.seq)).toEqual([4]);
  });

  it('服务没在录 / 旧包没有 status / 根本没有原生:回 null', async () => {
    expect(await attachMeetingRecording({ onSegment: () => {}, onError: () => {} }, { native: liveStub({ recording: false }).plugin as never })).toBeNull();
    expect(await attachMeetingRecording({ onSegment: () => {}, onError: () => {} }, { native: liveStub(new Error('not implemented')).plugin as never })).toBeNull();
    expect(await attachMeetingRecording({ onSegment: () => {}, onError: () => {} }, { native: null })).toBeNull();
  });
});

describe('WebView 那条退路', () => {
  it('每到一段就 stop 再 start 一个新的 —— 每段都是各自完整的文件', async () => {
    // **真时钟**:段的字节是 FileReader 异步读出来的(jsdom 的 Blob 没有 arrayBuffer),
    // 它不是定时器,假时钟推不动;所以把一段调成 30 毫秒,用真的等。
    FakeRecorder.made = 0;
    const got: RecordedSegment[] = [];
    const recording = await startMeetingRecording(
      { segmentMs: 30, onSegment: s => got.push(s), onError: () => {} },
      webDeps(),
    );
    expect(recording?.via).toBe('webview');
    expect(FakeRecorder.made).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 120));
    await recording?.stop();
    await new Promise(resolve => setTimeout(resolve, 40));
    // 轮换了好几次:每次都**新起一个** recorder,段号连着往上走,而且没有重号
    expect(FakeRecorder.made).toBeGreaterThan(2);
    expect(got.length).toBeGreaterThan(1);
    expect(got.map(s => s.seq)).toEqual(got.map((_, i) => i + 1));
    expect(got[0]?.mimeType).toBe('audio/mp4');
    // 每一段都是完整的一份(各自带着自己的字节),不是把一个大文件切开
    expect(got.every(s => s.bytes!.length > 0)).toBe(true);
  });

  it('stop 把最后一段吐出来,而且是幂等的', async () => {
    const got: RecordedSegment[] = [];
    const recording = await startMeetingRecording(
      { segmentMs: 60_000, onSegment: s => got.push(s), onError: () => {} },
      webDeps(),
    );
    await recording?.stop();
    await recording?.stop();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(got.map(s => s.seq)).toEqual([1]);
  });

  it('权限被拒 → 一句人话 + 返回 null,**不抛**', async () => {
    const errors: string[] = [];
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: e => errors.push(e) },
      { ...webDeps(), getUserMedia: async () => { throw denied; } },
    );
    expect(recording).toBeNull();
    expect(errors[0]).toContain('没有录音权限');
  });

  it('这台设备上连 MediaRecorder 都没有 → 一句人话 + null', async () => {
    const errors: string[] = [];
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: e => errors.push(e) },
      { ...webDeps(), mediaRecorder: null },
    );
    expect(recording).toBeNull();
    expect(errors[0]).toContain('没有 MediaRecorder');
  });

  it('电平算不出来就一直是 0,录音照旧', async () => {
    const recording = await startMeetingRecording(
      { onSegment: () => {}, onError: () => {} },
      { ...webDeps(), audioContext: null },
    );
    expect(recording?.level()).toBe(0);
    await recording?.stop();
  });
});
