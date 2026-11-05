import { describe, expect, it, vi } from 'vitest';

import {
  createGreetingPlaybackGate,
  greetingPresentationKey,
  initialGreetingPresentation,
  installPetPresentationBridge,
  playGreetingClipAtBoundary,
} from './strategistGreetingGate.ts';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('greetingPresentationKey', () => {
  it.each([
    { visible: false, compositeReady: true },
    { visible: true, compositeReady: false },
  ])('不满足完整视觉条件时不生成播放 key：%o', (state) => {
    expect(
      greetingPresentationKey({
        avatarId: 'shuangsheng-dj',
        presentationId: 3,
        ...state,
      }),
    ).toBeNull();
  });

  it.each([
    { avatarId: '', presentationId: 3 },
    { avatarId: 'shuangsheng-dj', presentationId: 0 },
    { avatarId: 'shuangsheng-dj', presentationId: Number.NaN },
  ])('角色或展示编号无效时不生成播放 key：%o', (state) => {
    expect(
      greetingPresentationKey({
        ...state,
        visible: true,
        compositeReady: true,
      }),
    ).toBeNull();
  });

  it('同一次展示得到稳定 key，再次展示得到新 key', () => {
    expect(
      greetingPresentationKey({
        avatarId: 'shuangsheng-dj',
        presentationId: 3,
        visible: true,
        compositeReady: true,
      }),
    ).toBe('shuangsheng-dj:3');
    expect(
      greetingPresentationKey({
        avatarId: 'shuangsheng-dj',
        presentationId: 4,
        visible: true,
        compositeReady: true,
      }),
    ).toBe('shuangsheng-dj:4');
  });
});

describe('pet presentation bridge', () => {
  it('Figma strip 默认隐藏，普通预览默认使用稳定 legacy presentation', () => {
    expect(initialGreetingPresentation(true, 500)).toEqual({
      visible: false,
      presentationId: 0,
      revealedElapsedMs: 0,
      receivedAt: 500,
    });
    expect(initialGreetingPresentation(false, 500)).toEqual({
      visible: true,
      presentationId: 1,
      revealedElapsedMs: 0,
      receivedAt: 500,
    });
  });

  it('开场白在 play 边界先只通知 numeric presentation id，再交给音频播放器', () => {
    const events: string[] = [];
    const audioStarted = vi.fn((id: number) => events.push(`trace:${id}`));
    const play = vi.fn((audioBase64: string, mime: string) => {
      events.push(`play:${audioBase64}:${mime}`);
    });

    playGreetingClipAtBoundary(
      { AibooHandheldStrip: { audioStarted } },
      3,
      { audioBase64: 'private-audio', mime: 'audio/mpeg' },
      play,
    );

    expect(audioStarted).toHaveBeenCalledWith(3);
    expect(audioStarted.mock.calls[0]).toEqual([3]);
    expect(events).toEqual(['trace:3', 'play:private-audio:audio/mpeg']);
  });

  it('卸载时恢复原 handler，且不覆盖后来接管 bridge 的 handler', () => {
    const previous = vi.fn();
    const replacement = vi.fn();
    const host: { __petPresentation?: (visible: boolean, id: number, revealedElapsedMs: number) => void } = {
      __petPresentation: previous,
    };
    const received: Array<[boolean, number, number]> = [];
    const uninstall = installPetPresentationBridge(host, (visible, id, revealedElapsedMs) => {
      received.push([visible, id, revealedElapsedMs]);
    });

    host.__petPresentation?.(true, 3, 120);
    expect(received).toEqual([[true, 3, 120]]);
    uninstall();
    expect(host.__petPresentation).toBe(previous);

    const uninstallAgain = installPetPresentationBridge(host, () => {});
    host.__petPresentation = replacement;
    uninstallAgain();
    expect(host.__petPresentation).toBe(replacement);
  });
});

describe('createGreetingPlaybackGate', () => {
  it('同一展示即使重复更新也只播放一次', async () => {
    const played: string[] = [];
    const gate = createGreetingPlaybackGate();
    const deps = {
      warm: async () => {},
      getClip: () => ({ audioBase64: 'greeting', mime: 'audio/mpeg' }),
      play: (clip: { audioBase64: string }) => {
        played.push(clip.audioBase64);
      },
    };

    gate.update('shuangsheng-dj:3', deps);
    await settle();
    gate.update('shuangsheng-dj:3', deps);
    await settle();

    expect(played).toEqual(['greeting']);
  });

  it('缓存预热完成前隐藏则不播放', async () => {
    const warming = deferred();
    const play = vi.fn();
    const gate = createGreetingPlaybackGate();

    gate.update('shuangsheng-dj:3', {
      warm: () => warming.promise,
      getClip: () => ({ audioBase64: 'three', mime: 'audio/mpeg' }),
      play,
    });
    gate.update(null, {
      warm: async () => {},
      getClip: () => null,
      play,
    });
    warming.resolve();
    await settle();

    expect(play).not.toHaveBeenCalled();
  });

  it('presentation 3 尚在预热时切到 4，只播放 4', async () => {
    const warmThree = deferred();
    const warmFour = deferred();
    const played: string[] = [];
    const gate = createGreetingPlaybackGate();

    gate.update('shuangsheng-dj:3', {
      warm: () => warmThree.promise,
      getClip: () => ({ audioBase64: 'three', mime: 'audio/mpeg' }),
      play: (clip) => {
        played.push(clip.audioBase64);
      },
    });
    gate.update('shuangsheng-dj:4', {
      warm: () => warmFour.promise,
      getClip: () => ({ audioBase64: 'four', mime: 'audio/mpeg' }),
      play: (clip) => {
        played.push(clip.audioBase64);
      },
    });
    warmThree.resolve();
    warmFour.resolve();
    await settle();

    expect(played).toEqual(['four']);
  });

  it('非 strip 预览使用稳定 legacy key，生命周期内只播放一次', async () => {
    const played: string[] = [];
    const gate = createGreetingPlaybackGate();
    const key = greetingPresentationKey({
      avatarId: 'rattan',
      presentationId: 1,
      visible: true,
      compositeReady: true,
    });
    const deps = {
      warm: async () => {},
      getClip: () => ({ audioBase64: 'legacy', mime: 'audio/mpeg' }),
      play: (clip: { audioBase64: string }) => {
        played.push(clip.audioBase64);
      },
    };

    gate.update(key, deps);
    await settle();
    gate.update(key, deps);
    await settle();

    expect(played).toEqual(['legacy']);
  });

  it('异步播放失败不会泄漏 unhandled rejection，同一展示也不重复尝试', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    const play = vi.fn(() => Promise.reject(new Error('audio failed')));
    const gate = createGreetingPlaybackGate();
    const deps = {
      warm: async () => {},
      getClip: () => ({ audioBase64: 'broken', mime: 'audio/mpeg' }),
      play,
    };

    try {
      gate.update('shuangsheng-dj:8', deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.update('shuangsheng-dj:8', deps);
      await settle();

      expect(unhandled).toEqual([]);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('接管播放返回值的 rejection handler，而不是丢弃异步失败', async () => {
    let rejectionHandled = false;
    const rejectedThenable = {
      then(
        _onFulfilled: ((value: void) => unknown) | undefined,
        onRejected: ((error: unknown) => unknown) | undefined,
      ) {
        rejectionHandled = typeof onRejected === 'function';
        onRejected?.(new Error('audio failed'));
        return Promise.resolve();
      },
    } as unknown as Promise<void>;
    const gate = createGreetingPlaybackGate();

    gate.update('shuangsheng-dj:10', {
      warm: async () => {},
      getClip: () => ({ audioBase64: 'broken', mime: 'audio/mpeg' }),
      play: () => rejectedThenable,
    });
    await settle();

    expect(rejectionHandled).toBe(true);
  });

  it('同步播放异常也被限制在当前展示内', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    const play = vi.fn(() => {
      throw new Error('native bridge threw');
    });
    const gate = createGreetingPlaybackGate();
    const deps = {
      warm: async () => {},
      getClip: () => ({ audioBase64: 'broken', mime: 'audio/mpeg' }),
      play,
    };

    try {
      gate.update('shuangsheng-dj:9', deps);
      await settle();
      gate.update('shuangsheng-dj:9', deps);
      await settle();

      expect(unhandled).toEqual([]);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
