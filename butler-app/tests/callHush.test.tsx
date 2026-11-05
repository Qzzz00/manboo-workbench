/**
 * 通话中不自动念、挂断后不再出声(2026-10-13,卡 E,维护者拍板)。
 *
 * ## 撞出来的事(10-13 下午真机,0.4.117 / Pixel 10 Pro)
 *
 * 他在手机 App 里打电话交代了一件事,豆包交回的那段回话一到聊天页,「新回复自动朗读」
 * (`speakNewReplies`)就把它念了 —— **通话中也念**(粒子球不抖,说明走的是手机外放、不是通话音轨),
 * **挂断后接着念**,像它还在汇报。维护者拍板:「挂断后手机不许再出声;通话中也不该自顾自念」。
 *
 * ## 这一份守什么
 *
 * 1. **通话中不自动念**(字幕、卡片照常出 —— 不出声不等于不告诉他);
 * 2. **通话期间到的那几条记成「念过了」**:挂断后不补念(他挂了就不该再出声);
 * 3. **挂断那一刻停下**:正在念的掐掉,**TTS 还在路上的那一段也作废** ——
 *    `stopSpeaking` 停得了正在放的,停不了一段还没开始放的,那正是「挂断后接着念」;
 * 4. **他自己点「重听」照念**(同免打扰那一处的规矩:拦的只有自己冒出来的那一声);
 * 5. 一通**开始**那一刻同样掐掉正在念的(电话都接通了还在念上一条回答就是在插嘴);
 * 6. 这一层卸掉(来电响铃顶上来 / 换页)也一样 —— 响铃时 `StagePage` 压根不挂,靠的就是这一条。
 *
 * 整页那一幕(通话中来的回复一声不出、挂断不补念、弹窗跟着收)在 `tests/StagePage.test.tsx`。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSpeak } from '../src/chat/useSpeak';
import type { ThreadMessage } from '../src/chat/chatModel';
import type { Session } from '../src/session';

/**
 * 放的每一段都记一笔(同 quietHours.test.tsx 那份):断言「到底出没出声」认的是这个计数。
 * `gate` 不为 null 时 TTS **卡在路上**,`gate()` 一下才回来 —— 第 3 条那一幕靠它摆出来。
 */
const player = vi.hoisted(() => ({ played: 0, stopped: 0, hold: false, end: null as null | (() => void) }));
vi.mock('../src/aiboo/lipsyncPlayer', () => ({
  playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => {
    player.played += 1;
    if (player.hold) { player.end = () => onEnded?.(); return; }
    onEnded?.();
  },
  stopSpeaking: () => { player.stopped += 1; player.end?.(); player.end = null; },
  isSpeaking: () => false,
}));

afterEach(() => {
  player.played = 0;
  player.stopped = 0;
  player.hold = false;
  player.end = null;
});

/** 语音配好了的那台:一问就回一段音频。`wait` 给的那一下用来把 TTS 卡在路上。 */
function fakeSession(wait?: Promise<void>): Session {
  return {
    client: { mode: () => 'direct' },
    voice: {
      tts: async () => {
        if (wait !== undefined) await wait;
        return { ok: true as const, status: 200, data: new Blob([new Uint8Array([1])]) };
      },
    },
  } as unknown as Session;
}

function reply(id: string, text: string): ThreadMessage {
  return { taskId: id, butler: { kind: 'reply', text } } as unknown as ThreadMessage;
}

/** 这一页在通话里 / 不在通话里(第七个参数就是 `inCall`)。 */
function mountSpeak(session: Session, inCall: boolean) {
  return renderHook(
    ({ call }: { call: boolean }) => useSpeak(session, true, undefined, { current: 0 }, undefined, undefined, call),
    { initialProps: { call: inCall } },
  );
}

describe('useSpeak · 通话中不自动念', () => {
  it('★通话中新回复一声不出(10-13 撞出这张卡的那一幕)', async () => {
    const { result } = mountSpeak(fakeSession(), true);
    act(() => { result.current.speakNewReplies([]); });
    await act(async () => { result.current.speakNewReplies([reply('t-1', '豆包那段回话。')]); });
    expect(player.played).toBe(0);
  });

  it('不在通话里照念 —— 拦的是通话中那一声,不是把朗读关了', async () => {
    const { result } = mountSpeak(fakeSession(), false);
    act(() => { result.current.speakNewReplies([]); });
    await act(async () => { result.current.speakNewReplies([reply('t-1', '豆包那段回话。')]); });
    expect(player.played).toBe(1);
  });

  it('★通话中拦掉的照旧记成「念过了」:挂断之后不把电话里那几条补念出来', async () => {
    const { result, rerender } = mountSpeak(fakeSession(), true);
    act(() => { result.current.speakNewReplies([]); });
    const thread = [reply('t-1', '电话里那件事的回话。')];
    await act(async () => { result.current.speakNewReplies(thread); });
    expect(player.played).toBe(0);

    // 挂了(同一次挂载:拨出去那条路就是这样,这一页不重挂)。同一条 thread 再过一拍:不补念。
    await act(async () => { rerender({ call: false }); });
    await act(async () => { result.current.speakNewReplies(thread); });
    expect(player.played).toBe(0);
  });

  it('★通话中他自己点「重听」照念 —— 那是他要听的(同免打扰那一处的规矩)', async () => {
    const { result } = mountSpeak(fakeSession(), true);
    let why: string | undefined = 'x';
    await act(async () => { why = await result.current.speakText('t-1:好', '好'); });
    expect(player.played).toBe(1);
    expect(why).toBeUndefined();
  });
});

describe('useSpeak · 挂断那一刻停下', () => {
  it('★正在念的那一段:挂断就掐掉(不是等它念完)', async () => {
    player.hold = true;
    const { result, rerender } = mountSpeak(fakeSession(), false);
    act(() => { result.current.speakNewReplies([]); });
    await act(async () => { result.current.speakNewReplies([reply('t-1', '很长的一段汇报。')]); });
    expect(player.played).toBe(1);
    expect(result.current.speaking).toBe(true);

    await act(async () => { rerender({ call: true }); });
    expect(player.stopped).toBeGreaterThan(0);
    expect(result.current.speaking).toBe(false);
  });

  it('★TTS 还在路上时挂断:回来那一段不放(stopSpeaking 停不了一段还没开始放的音频)', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { result, rerender } = mountSpeak(fakeSession(gate), true);
    act(() => { result.current.speakNewReplies([]); });
    // 通话中他自己点了「重听」,音频还没回来他就挂了。
    let pending: Promise<string | undefined> | null = null;
    act(() => { pending = result.current.speakText('t-1:好', '好'); });
    await act(async () => { rerender({ call: false }); });
    await act(async () => { release(); await pending; });

    expect(player.played).toBe(0);
  });

  it('★这一层卸掉(来电响铃顶上来 / 换页):路上那一段也不放', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { result, unmount } = mountSpeak(fakeSession(gate), false);
    act(() => { result.current.speakNewReplies([]); });
    let pending: Promise<string | undefined> | null = null;
    act(() => { pending = result.current.speakText('t-1:好', '好'); });
    unmount();
    await act(async () => { release(); await pending; });

    expect(player.played).toBe(0);
  });
});
