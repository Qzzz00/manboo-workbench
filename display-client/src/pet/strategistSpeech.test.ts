import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpeaker } from './strategistSpeech.ts';

const EP = { baseUrl: 'http://aiboo', token: 'jwt' };

/** 假播放：记录播了哪些片段，下一微任务即"播完"。 */
function fakePlay(played: string[]) {
  return (audioBase64: string) => {
    played.push(audioBase64);
    return Promise.resolve();
  };
}

function speaker(opts: {
  ttsImpl?: ReturnType<typeof vi.fn>;
  played?: string[];
  onLevel?: (l: number) => void;
  onSpokenChars?: (n: number) => void;
  playImpl?: (b64: string, mime: string) => Promise<void>;
}) {
  const played = opts.played ?? [];
  return createSpeaker({
    endpoint: () => EP,
    // ★别用 btoa(中文)——btoa 只吃 Latin1，中文会抛 InvalidCharacterError，
    // 然后被实现里「单段失败就跳过」正确地吞掉，测试看起来像实现坏了（栽过一次）。
    ttsImpl: (opts.ttsImpl ??
      vi.fn(async () => ({ audioBase64: 'QQ==', mime: 'audio/mpeg' }))) as never,
    playImpl: opts.playImpl ?? fakePlay(played),
    onLevel: opts.onLevel,
    onSpokenChars: opts.onSpokenChars,
  });
}

/** 让排队的 promise 链跑完。 */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** 长度 n 的一句（带句号），用来越过 MERGE_MIN_CHARS=80 那条线。 */
const sentence = (n: number, ch = '啊') => ch.repeat(n - 1) + '。';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSpeaker', () => {
  it('攒够一句才合成，半句不发', async () => {
    const spoken: string[] = [];
    const ttsImpl = vi.fn(async (_ep: unknown, p: { text: string }) => {
      spoken.push(p.text);
      return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
    });
    const sp = speaker({ ttsImpl });

    sp.push('你现在');
    await settle();
    expect(ttsImpl).not.toHaveBeenCalled();

    sp.push('在道馆里。');
    await settle();
    expect(ttsImpl).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual(['你现在在道馆里。']);
  });

  it('★第一句单独发（保住首字延迟），之后攒到 80 字才成一段', async () => {
    const spoken: string[] = [];
    const ttsImpl = vi.fn(async (_ep: unknown, p: { text: string }) => {
      spoken.push(p.text);
      return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
    });
    const sp = speaker({ ttsImpl });

    sp.push('第一句。');
    await settle();
    expect(spoken).toEqual(['第一句。']); // 立刻发，不等攒

    // 第二、三句加起来还不到 80 字 → 还不发
    sp.push(sentence(30) + sentence(30));
    await settle();
    expect(spoken).toHaveLength(1);

    // 再来一句凑过 80 → 三句**合成一段**发出去（只有一次合成，语调只起一次）
    sp.push(sentence(30));
    await settle();
    expect(spoken).toHaveLength(2);
    expect(spoken[1]).toHaveLength(90);
  });

  it('★flush 把尾巴和攒着的那段合成一段发——两三个字的碎片自己起一次调最刺耳', async () => {
    const spoken: string[] = [];
    const ttsImpl = vi.fn(async (_ep: unknown, p: { text: string }) => {
      spoken.push(p.text);
      return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
    });
    const sp = speaker({ ttsImpl });

    sp.push('结论在这。攒着的一句。没有句号的收尾');
    await settle();
    expect(spoken).toEqual(['结论在这。']); // 只有第一句发了

    sp.flush();
    await settle();
    expect(spoken).toEqual(['结论在这。', '攒着的一句。没有句号的收尾']);
  });

  it('★合成不等播放：第一段还在播时，后面那段就已经在合成（旧实现缺的正是这一半）', async () => {
    const spoken: string[] = [];
    let releaseFirst = () => {};
    const firstPlayed = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let plays = 0;
    const ttsImpl = vi.fn(async (_ep: unknown, p: { text: string }) => {
      spoken.push(p.text);
      return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
    });
    const sp = speaker({
      ttsImpl,
      // 第一段永远播不完，直到测试放行
      playImpl: () => (plays++ === 0 ? firstPlayed : Promise.resolve()),
    });

    sp.push('第一句。');
    sp.push(sentence(90));
    await settle();

    // 第一段还卡在播放里，第二段的合成**已经发出去了**
    expect(plays).toBe(1);
    expect(spoken).toHaveLength(2);

    releaseFirst();
    await settle();
    expect(plays).toBe(2);
  });

  it('★合成失败重试一次；仍失败不再静默——warn 进 logcat，且不卡住后面的段', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ★按**文本**判成败，不按调用次数：合成现在是并发预取的，两段的尝试会交错，
    //   按次数写的桩会随交错顺序变结果（第一版就这么翻车了）。
    const ttsImpl = vi.fn(async (_ep: unknown, p: { text: string }) => {
      if (p.text.startsWith('坏的')) throw new Error('HTTP_500');
      return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
    });
    const played: string[] = [];
    const sp = speaker({ ttsImpl, played });

    sp.push('坏的一句。');
    sp.push(sentence(90));
    await settle();

    expect(ttsImpl).toHaveBeenCalledTimes(3); // 1 段失败×2 + 2 段成功×1
    expect(played).toHaveLength(1); // 只有第二段真播了
    expect(warn).toHaveBeenCalled();
  });

  it('★念到第几个字要单调推进——面板靠它同步滚动，卡住就不再往下滚', async () => {
    const marks: number[] = [];
    const sp = speaker({ onSpokenChars: (n) => marks.push(n) });

    sp.push('第一句。');
    sp.push(sentence(90));
    sp.flush();
    await settle();

    expect(marks).toEqual([4, 94]);
  });

  it('合成失败的那段也要推进字数，否则面板停在半截', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marks: number[] = [];
    const ttsImpl = vi.fn(async () => {
      throw new Error('HTTP_500');
    });
    const sp = speaker({ ttsImpl, onSpokenChars: (n) => marks.push(n) });

    sp.push('第一句。');
    sp.flush();
    await settle();

    expect(marks).toEqual([4]);
  });

  it('stop 之后不再合成也不再播（用户点角色打断）', async () => {
    const ttsImpl = vi.fn(async () => ({ audioBase64: 'QQ==', mime: 'audio/mpeg' }));
    const sp = speaker({ ttsImpl });

    sp.stop();
    sp.push('停了还说话。');
    sp.flush();
    await settle();

    expect(ttsImpl).not.toHaveBeenCalled();
  });

  it('★口型是整篇的作用域：段间不闭嘴，整篇念完才归零', async () => {
    const levels: number[] = [];
    const sp = speaker({ onLevel: (l) => levels.push(l) });

    sp.push('第一句。');
    sp.push(sentence(90));
    await settle();
    // ★两段都播完了，但整篇还没结束 → 不能归零。
    //   旧实现（口型按**段**起停）在这里必然已经 onLevel(0) 过一次，
    //   真机上就是段间嘴抽搐一下。
    expect(levels).not.toContain(0);

    sp.flush();
    await settle();
    expect(levels[levels.length - 1]).toBe(0); // 收尾必须归零，否则嘴张着不动
  });
});

describe('整篇音频焦点只申请一次（游戏音量不再一段一抽）', () => {
  it('beginUtterance/endUtterance 各恰好一次，中间夹着 N 段播放', async () => {
    const calls: string[] = [];
    const g = globalThis as unknown as { window?: unknown };
    const hadWindow = 'window' in globalThis;
    (globalThis as unknown as { window: unknown }).window = {
      AibooStrategistAudio: {
        play: () => {},
        stop: () => {},
        beginUtterance: () => calls.push('begin'),
        endUtterance: () => calls.push('end'),
      },
    };
    try {
      const played: string[] = [];
      const sp = speaker({ played });
      sp.push('第一句。');
      sp.push(sentence(90));
      sp.flush();
      await settle();

      expect(played).toHaveLength(2); // 首句 + 90 字那段；flush 时已无尾巴
      expect(calls).toEqual(['begin', 'end']);
    } finally {
      if (!hadWindow) delete g.window;
    }
  });
});
