/**
 * 「按住说话」那套动作 + 真的录音 hook(2026-09-24,卡 feat/phone-composer-call-slot)。
 *
 * 新的麦克风键**一按下就开录**(统筹真机排查:以前要先等 260ms 判「按住」、再等 getUserMedia,0.4–0.6 秒才有反应,
 * 人按下就开口,很容易觉得「按住没反应」)。一按下就开录,「松手时麦克风还没真打开」这件事就从偶发变成常态 ——
 * 快点一下、或者头一次按住时弹了权限框。这里钉的是那段空档里的三件事:
 *   1. 松手 / 作废之后,等回来的麦克风当场关掉,**不留一段没人按着的录音**(以前会一直录到 20 秒上限,浮层一直挂着);
 *   2. 取消后紧接着再按,上一次的「过一会儿回 idle」不许把这一次冲掉;
 *   3. 麦克风权限被拒**每次**都说一句(以前第二次起就静默:按了没反应,也不说为什么);同一个错只说一次。
 *
 * 这里不假掉 useVoiceRecorder(StageComposer / PhoneComposer 的用例假掉了它):要测的正是它。
 * jsdom 没有 getUserMedia / MediaRecorder / AudioContext,补最小的假货;AudioContext 缺席时录音 hook 自己跳过音量表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TOO_SHORT_TEXT, useHoldToTalk } from '../src/chat/useHoldToTalk';
import { MIC_PERMISSION_TEXT } from '../src/aiboo/useVoiceRecorder';
import type { AsrResult } from '../src/api/voice';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean { return false; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: MediaStream) { FakeMediaRecorder.instances.push(this); }
  start(): void { this.state = 'recording'; }
  stop(): void { this.state = 'inactive'; this.onstop?.(); }
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  getUserMedia = vi.fn();
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

function mountHold(overrides: { onError?: (text: string) => void; transcribe?: (wav: Blob) => Promise<AsrResult> } = {}) {
  const onText = vi.fn();
  const onError = vi.fn(overrides.onError ?? (() => {}));
  const transcribe = vi.fn(overrides.transcribe ?? (async () => ({ ok: true, text: '周五交报销' }) as AsrResult));
  const view = renderHook(({ err }: { err: (text: string) => void }) => useHoldToTalk({ transcribe, onText, onError: err }), { initialProps: { err: onError } });
  return { ...view, onText, onError, transcribe };
}

describe('按住说话 · 麦克风还没打开就松手', () => {
  it('一按下就是录音态(还在要麦克风也算);松手当「太短」,等回来的麦克风当场关掉,不留一段没人按着的录音', async () => {
    const gum = deferred<MediaStream>();
    getUserMedia.mockImplementation(() => gum.promise);
    const { result, onError, transcribe } = mountHold();

    act(() => { result.current.begin(700); });
    expect(result.current.recording).toBe(true);

    await act(async () => { await result.current.end(); });
    expect(onError).toHaveBeenCalledWith(TOO_SHORT_TEXT);
    expect(transcribe).not.toHaveBeenCalled();

    const { stream, track } = fakeStream();
    await act(async () => { gum.resolve(stream); await gum.promise; await Promise.resolve(); });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(result.current.recording).toBe(false);
  });

  it('被系统打断(abort)也一样:作废那一路,回来的麦克风关掉', async () => {
    const gum = deferred<MediaStream>();
    getUserMedia.mockImplementation(() => gum.promise);
    const { result } = mountHold();
    act(() => { result.current.begin(700); });
    act(() => { result.current.abort(); });
    const { stream, track } = fakeStream();
    await act(async () => { gum.resolve(stream); await gum.promise; await Promise.resolve(); });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(result.current.recording).toBe(false);
  });

  it('上滑到「松开取消」再松手:作废,不说「太短」', async () => {
    const gum = deferred<MediaStream>();
    getUserMedia.mockImplementation(() => gum.promise);
    const { result, onError } = mountHold();
    act(() => { result.current.begin(700); });
    act(() => { result.current.move(500); });
    expect(result.current.cancelHint).toBe(true);
    await act(async () => { await result.current.end(); });
    expect(onError).not.toHaveBeenCalled();
    const { stream, track } = fakeStream();
    await act(async () => { gum.resolve(stream); await gum.promise; await Promise.resolve(); });
    expect(track.stop).toHaveBeenCalled();
  });

  it('取消后马上再按一次:上一次的「过一会儿回 idle」不会把这一次冲掉', async () => {
    const first = fakeStream();
    getUserMedia.mockImplementation(async () => first.stream);
    const { result } = mountHold();
    await act(async () => { result.current.begin(700); });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    act(() => { result.current.abort(); });
    const second = fakeStream();
    getUserMedia.mockImplementation(async () => second.stream);
    await act(async () => { result.current.begin(700); });
    expect(result.current.recording).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 360)); });
    expect(result.current.recording).toBe(true);
    expect(second.track.stop).not.toHaveBeenCalled();
    act(() => { result.current.abort(); });
  });
});

describe('按住说话 · 正常一句', () => {
  it('麦克风开了、按够了再松手:转文字交给 onText', async () => {
    const { stream } = fakeStream();
    getUserMedia.mockImplementation(async () => stream);
    const { result, onText, transcribe } = mountHold();
    await act(async () => { result.current.begin(700); });
    expect(result.current.recording).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 560)); });
    await act(async () => { await result.current.end(); });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('周五交报销');
  });
});

describe('按住说话 · 麦克风权限', () => {
  it('被拒每次都说一句人话(以前第二次起就不吭声了)', async () => {
    getUserMedia.mockImplementation(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
    const { result, onError } = mountHold();
    await act(async () => { result.current.begin(700); });
    expect(onError).toHaveBeenLastCalledWith(MIC_PERMISSION_TEXT);
    await act(async () => { result.current.begin(700); });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(MIC_PERMISSION_TEXT).not.toMatch(/浏览器/);
  });

  it('同一个错只说一次:外面每次重画都换一个 onError,也不会把那句话再弹一遍', async () => {
    getUserMedia.mockImplementation(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
    const { result, onError, rerender } = mountHold();
    await act(async () => { result.current.begin(700); });
    expect(onError).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    rerender({ err: later });
    rerender({ err: vi.fn() });
    expect(later).not.toHaveBeenCalled();
  });
});
