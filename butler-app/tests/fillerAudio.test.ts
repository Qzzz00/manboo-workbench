/**
 * 缓冲语:**手机放包里那几句**(2026-09-20,Ben:「缓冲语可以存到手机里啊」)。
 *
 * 这一份钉住的正是 0.2.46 那一版做不到、以及做过头会难听的那几件:
 *   ① 到点才垫(她答得快的那几轮一个字都不垫);
 *   ② 她的真声一到就掐,**不重叠**;
 *   ③ 他一开口也掐;
 *   ④ 不重复;
 *   ⑤ 一轮最多两句,而且同一类只垫一次(**普通的慢回合只有一句**,2026-09-22);
 *   ⑥ 放不出来只剩字幕,**不许把通话带走**;
 *   ⑦ 表里每一句都有一个真的音频文件躺在包里(不然电话里会有一句是哑的);
 *   ⑧ **轮号变了但中间没人开过口 = 还是同一次等待**(2026-09-22,Ben 真机:
 *      「在生成回复之前,它一次念了好几句」)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FILLER_LINES,
  FILLER_MAX_PER_ROUND,
  FILLER_WAIT_MS,
  FillerBag,
  type FillerLine,
  type FillerSignalIn,
  type FillerSkipReason,
  createFillerAudio,
  fillerAssetUrl,
} from '../src/call/fillerAudio';
import { FILLER_FADE_MS, createHtmlFillerPlayer } from '../src/call/fillerPlayer';

/** 手动推时钟的假定时器:用例里一毫秒都不用真等。 */
function fakeTimers() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    setTimer(fn: () => void, ms: number) {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    /** 把所有还没被撤掉的都跑一遍。 */
    fire() {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.fn();
    },
    get armed() { return pending.filter((entry) => !entry.cancelled).length; },
    get delays() { return pending.map((entry) => entry.ms); },
  };
}

function harness(over: Partial<Parameters<typeof createFillerAudio>[0]> = {}) {
  const played: FillerLine[] = [];
  const captions: string[] = [];
  const skipped: { reason: FillerSkipReason; round: number }[] = [];
  let stops = 0;
  let resolvePlay: (() => void) | undefined;
  const timers = fakeTimers();
  const audio = createFillerAudio({
    play: (line) => { played.push(line); return new Promise<void>((done) => { resolvePlay = done; }); },
    stop: () => { stops += 1; },
    onPlayed: (line) => { captions.push(line.text); },
    onSkipped: (reason, signal) => { skipped.push({ reason, round: signal.round }); },
    setTimer: timers.setTimer,
    ...over,
  });
  return {
    audio, played, captions, skipped, timers,
    get stops() { return stops; },
    /** 那一句放完了。 */
    finish() { resolvePlay?.(); resolvePlay = undefined; return Promise.resolve(); },
  };
}

const thinking = (round: number): FillerSignalIn => ({ kind: 'thinking', round });

describe('到点才垫', () => {
  it('收到信号先等着,到点了才放', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    expect(h.played).toEqual([]);
    h.timers.fire();
    expect(h.played).toHaveLength(1);
    expect(h.captions).toHaveLength(1);
  });

  it('等的就是 700 毫秒', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    expect(h.timers.delays).toEqual([FILLER_WAIT_MS]);
    expect(FILLER_WAIT_MS).toBe(700);
  });

  it('**她 700 毫秒之内就出声了 → 一个字都不垫**(这是最常见的一种,而且是好事)', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.audio.butlerSpoke();
    h.timers.fire();
    expect(h.played).toEqual([]);
    expect(h.skipped).toEqual([{ reason: 'she-spoke', round: 1 }]);
  });

  it('同一轮来第二条信号只是重新计时,不排第二根', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.audio.signal(thinking(1));
    expect(h.timers.armed).toBe(1);
    h.timers.fire();
    expect(h.played).toHaveLength(1);
  });
});

describe('她一出声就掐', () => {
  it('她那条字幕到了 → 当场掐掉正在放的那一句', async () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    expect(h.played).toHaveLength(1);
    h.audio.butlerSpoke();
    expect(h.stops).toBe(1);
  });

  it('音轨真的有能量也算她出声(字幕丢了一条还有这一路)', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    h.audio.setRemoteSpeaking(true);
    expect(h.stops).toBe(1);
  });

  it('**到点时她正说着就不垫**(上一句还没完,插进去就是两个人一起说)', () => {
    const h = harness();
    h.audio.setRemoteSpeaking(true);
    h.audio.signal(thinking(1));
    h.timers.fire();
    expect(h.played).toEqual([]);
    expect(h.skipped.map((s) => s.reason)).toEqual(['she-is-speaking']);
  });

  it('放完了之后再掐一次不会多掐一下(她本来就已经不在放了)', async () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.butlerSpoke();
    expect(h.stops).toBe(0);
  });
});

describe('他一开口也掐', () => {
  it('他说话了 → 手机别再自己念叨', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    h.audio.userSpoke();
    expect(h.stops).toBe(1);
  });

  it('新的一轮(他说完一句、轮号才跟着变)会把还在放的上一句掐掉', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    // 他开口 —— 当场掐一次;这也让下一个轮号成为**真的**新一轮。
    h.audio.userSpoke();
    h.audio.signal(thinking(2));
    expect(h.stops).toBe(1);
  });
});

describe('一轮最多两句', () => {
  it('慢工具那种回合:先「我想想」,再那句工具专用的', async () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.signal({ kind: 'tool', tool: 'scan_projects', round: 1 });
    h.timers.fire();
    expect(h.played).toHaveLength(2);
    expect(h.played[1]?.text).toContain('仓库');
  });

  it(`第 ${FILLER_MAX_PER_ROUND + 1} 句不放了(再多就成了自言自语)`, async () => {
    const h = harness();
    // 一轮里两类各垫一句 —— 正好垫满 FILLER_MAX_PER_ROUND。
    for (const kind of ['thinking', 'tool'] as const) {
      h.audio.signal({ kind, round: 1 });
      h.timers.fire();
      await h.finish();
      await Promise.resolve();
    }
    expect(h.played).toHaveLength(FILLER_MAX_PER_ROUND);
    // 再来一条:硬上限那道闸先拦(它排在同类那道前面 —— 先说"这一轮够了"比先说"这一类说过了"准确)。
    h.audio.signal({ kind: 'tool', round: 1 });
    expect(h.played).toHaveLength(FILLER_MAX_PER_ROUND);
    expect(h.skipped.map((s) => s.reason)).toContain('round-full');
  });

  it('一轮里两类都垫过之后,硬上限那道闸也还在(maxPerRound 调到 1 就只剩一句)', async () => {
    const h = harness({ maxPerRound: 1 });
    h.audio.signal({ kind: 'thinking', round: 1 });
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.signal({ kind: 'tool', tool: 'scan_projects', round: 1 });
    expect(h.played).toHaveLength(1);
    expect(h.skipped.map((s) => s.reason)).toContain('round-full');
  });

  it('下一轮重新算(中间她开过口 —— 那才是真的下一轮)', async () => {
    const h = harness({ maxPerRound: 1 });
    h.audio.signal(thinking(1));
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.butlerSpoke();
    h.audio.signal(thinking(2));
    h.timers.fire();
    expect(h.played).toHaveLength(2);
  });

  /**
   * ——— Ben 2026-09-22 真机:「在生成回复之前,它一次念了好几句」———
   *
   * 复现的是工人那边**一个回合被工具步切成好几轮**的样子:
   * `@livekit/agents` 里模型每调一次工具,状态就在 `speaking ↔ thinking` 之间来回一次,
   * 旧的工人每回到一次 `thinking` 就开一个新轮号。
   * 手机这一侧的闸是:**从上一句缓冲语起她和他都没开过口 → 这还是同一次等待**。
   */
  it('**一个慢回合只放一句**:轮号涨了好几次,但中间没人开过口', async () => {
    const h = harness();
    for (const round of [1, 2, 3, 4, 5]) {
      h.audio.signal(thinking(round));
      h.timers.fire();
      await h.finish();
      await Promise.resolve();
    }
    expect(h.played).toHaveLength(1);
    expect(h.captions).toHaveLength(1);
    // 没垫成的那几条如实说得出原因(排查「怎么只有一句」时全靠它)。
    expect(h.skipped.map((s) => s.reason)).toEqual(['kind-done', 'kind-done', 'kind-done', 'kind-done']);
  });

  it('同一次等待里轮号涨了也不掐正在放的那一句(没有人在跟它抢话)', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    h.audio.signal(thinking(2));
    h.audio.signal(thinking(3));
    expect(h.stops).toBe(0);
    expect(h.played).toHaveLength(1);
  });

  /**
   * 慢工具那种两段的回合照旧是两句(设计第 ⑤ 条),**即使轮号在中间涨了**:
   * 旧工人把「她说了半句、又去调工具」切成两轮,那仍然是同一次等待里的第二句。
   */
  it('轮号涨了之后那句工具专用的照放(一次等待最多还是两句)', async () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.signal({ kind: 'tool', tool: 'scan_projects', round: 2 });
    h.timers.fire();
    await h.finish();
    await Promise.resolve();
    h.audio.signal({ kind: 'tool', round: 3 });
    h.timers.fire();
    expect(h.played).toHaveLength(2);
    expect(h.played[1]?.text).toContain('仓库');
    expect(h.skipped.map((s) => s.reason)).toContain('round-full');
  });

  it('上一句还在放就不叠第二句', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    h.audio.signal({ kind: 'tool', tool: 'scan_projects', round: 1 });
    h.timers.fire();
    expect(h.played).toHaveLength(1);
    expect(h.skipped.map((s) => s.reason)).toContain('still-playing');
  });
});

describe('挑哪一句', () => {
  it('工具专用那句按名字直接取,**不随机**(说清楚在干什么比说得花哨重要)', () => {
    const h = harness();
    h.audio.signal({ kind: 'tool', tool: 'scan_projects', round: 1 });
    h.timers.fire();
    expect(h.played[0]?.id).toBe('tool-scan-projects');
    expect(h.played[0]?.text).toBe('我看一下你的仓库,大概几秒。');
  });

  it('没听说过的工具用那句通用的', () => {
    const h = harness();
    h.audio.signal({ kind: 'tool', tool: '以后才有的某件工具', round: 1 });
    h.timers.fire();
    expect(h.played[0]?.id).toBe('tool-any');
  });

  it('平时那几轮只从 thinking 那一堆里挑', () => {
    const h = harness();
    for (let round = 1; round <= 6; round += 1) {
      h.audio.signal(thinking(round));
      h.timers.fire();
      h.audio.butlerSpoke();
    }
    expect(h.played.every((line) => line.kind === 'thinking')).toBe(true);
  });

  it('字幕上写的就是喇叭里放的那一句', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    expect(h.captions).toEqual([h.played[0]?.text]);
  });
});

describe('放不出来', () => {
  it('play 抛了只剩字幕,通话照旧', () => {
    const h = harness({ play: () => { throw new Error('解码不了'); } });
    expect(() => { h.audio.signal(thinking(1)); h.timers.fire(); }).not.toThrow();
    expect(h.captions).toHaveLength(1);
    expect(h.skipped.map((s) => s.reason)).toContain('play-failed');
  });

  it('play reject 了也一样,而且这一轮还能再垫一句', async () => {
    const h = harness({ play: async () => { throw new Error('自动播放被拦了'); } });
    h.audio.signal(thinking(1));
    h.timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.skipped.map((s) => s.reason)).toContain('play-failed');
    h.audio.signal({ kind: 'tool', round: 1 });
    h.timers.fire();
    expect(h.captions).toHaveLength(2);
  });

  it('挂断之后信号来了也不垫', () => {
    const h = harness();
    h.audio.dispose();
    h.audio.signal(thinking(1));
    h.timers.fire();
    expect(h.played).toEqual([]);
  });

  it('挂断时正在放的那一句要掐掉', () => {
    const h = harness();
    h.audio.signal(thinking(1));
    h.timers.fire();
    h.audio.dispose();
    expect(h.stops).toBe(1);
  });
});

describe('FillerBag:不重复', () => {
  const line = (id: string): FillerLine => ({ id, kind: 'thinking', text: id });

  it('一副牌发完才可能再听到第一句', () => {
    const bag = new FillerBag([line('A'), line('B'), line('C')], () => 0);
    const first = [bag.next(), bag.next(), bag.next()].map((x) => x?.id);
    expect(new Set(first).size).toBe(3);
    expect([...first].sort()).toEqual(['A', 'B', 'C']);
  });

  it('重洗之后第一张不等于刚发出去的那张(连着两次同一句最假)', () => {
    const bag = new FillerBag([line('A'), line('B')], () => 0);
    const dealt: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const card = bag.next();
      if (card !== undefined) dealt.push(card.id);
    }
    for (let i = 1; i < dealt.length; i += 1) expect(dealt[i]).not.toBe(dealt[i - 1]);
  });

  it('同一个 id 进两次只算一张(不然它会比别的常出现,听起来像卡带)', () => {
    expect(new FillerBag([line('A'), line('A'), line('B')]).size).toBe(2);
  });

  it('池子空了就什么都不放,**不放一段空音频**', () => {
    expect(new FillerBag([]).next()).toBeUndefined();
  });
});

describe('那几句话与包里的文件', () => {
  const dir = resolve(__dirname, '../public/filler');

  it('6–15 句,平时那几句、工具那几句、应声那几声都有', () => {
    // 2026-10-02 多了 `ack` 那几声(卡「声音与形象跟着话走」第 5 件;放它的是 call/ackAudio.ts)。
    expect(FILLER_LINES.length).toBeGreaterThanOrEqual(6);
    expect(FILLER_LINES.length).toBeLessThanOrEqual(15);
    expect(FILLER_LINES.filter((l) => l.kind === 'thinking').length).toBeGreaterThanOrEqual(3);
    expect(FILLER_LINES.some((l) => l.kind === 'tool' && l.tool === 'scan_projects')).toBe(true);
    expect(FILLER_LINES.some((l) => l.kind === 'tool' && l.tool === undefined)).toBe(true);
    expect(FILLER_LINES.filter((l) => l.kind === 'ack').length).toBeGreaterThanOrEqual(3);
  });

  it('**应声那几声不进垫场的牌堆**(它们是「他还说着的时候」插的,不是垫场)', () => {
    const bag = new FillerBag(FILLER_LINES.filter((l) => l.kind === 'thinking'));
    expect(bag.size).toBe(FILLER_LINES.filter((l) => l.kind === 'thinking').length);
    expect(FILLER_LINES.filter((l) => l.kind === 'ack').every((l) => l.text.length <= 4)).toBe(true);
  });

  it('平时那几句都短(说完要能被她自己的下一句接上)', () => {
    for (const line of FILLER_LINES.filter((l) => l.kind === 'thinking')) {
      expect(line.text.length).toBeLessThanOrEqual(8);
      expect(line.text.trim()).toBe(line.text);
    }
  });

  it('**表里每一句都有一个真的音频躺在包里**(缺一个就是电话里有一句是哑的)', () => {
    for (const line of FILLER_LINES) {
      const path = resolve(dir, `${line.id}.m4a`);
      const size = statSync(path).size;
      // 一句一秒多的 AAC 至少几 KB;几百字节的多半是个空壳。
      expect(size).toBeGreaterThan(2000);
    }
  });

  it('包里没有表外的多余音频(留着就是包里多一句谁也不会放的话)', () => {
    const ids = new Set(FILLER_LINES.map((l) => `${l.id}.m4a`));
    const strays = readdirSync(dir).filter((name) => name.endsWith('.m4a') && !ids.has(name));
    expect(strays).toEqual([]);
  });

  it('加起来几十 KB —— 不该为了几句话把安装包撑大', () => {
    const total = FILLER_LINES.reduce((sum, line) => sum + statSync(resolve(dir, `${line.id}.m4a`)).size, 0);
    expect(total).toBeLessThan(400 * 1024);
  });

  it('manifest 和表对得上(它是「这几句是哪天、用哪个音色合的」唯一的凭据)', () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as {
      lines: { id: string; text: string; file: string }[];
      generated_at: string;
    };
    expect(manifest.lines.map((l) => l.id)).toEqual(FILLER_LINES.map((l) => l.id));
    expect(manifest.lines.map((l) => l.text)).toEqual(FILLER_LINES.map((l) => l.text));
    expect(Number.isNaN(Date.parse(manifest.generated_at))).toBe(false);
  });

  it('路径是相对的(Capacitor 从 http://localhost 根路径起服务)', () => {
    expect(fillerAssetUrl('think-1')).toBe('filler/think-1.m4a');
    expect(fillerAssetUrl('think-1').startsWith('/')).toBe(false);
  });
});

describe('真的那个播放器', () => {
  function fakeAudio() {
    const calls: string[] = [];
    const made: { url: string; volume: number; paused: boolean; el: HTMLAudioElement }[] = [];
    const makeAudio = (url: string): HTMLAudioElement => {
      const el = {
        preload: '',
        volume: 1,
        currentTime: 0,
        src: url,
        onended: null as null | (() => void),
        onerror: null as null | (() => void),
        play: () => { calls.push(`play:${url}`); return Promise.resolve(); },
        pause: () => { calls.push(`pause:${url}`); const entry = made.find((m) => m.url === url); if (entry !== undefined) entry.paused = true; },
      } as unknown as HTMLAudioElement;
      made.push({ url, volume: 1, paused: false, el });
      return el;
    };
    return { calls, made, makeAudio };
  }

  it('同一句放第二遍**不再建一个 `<audio>`**(到点那一刻不能再去读一次文件)', async () => {
    const fake = fakeAudio();
    const timers = fakeTimers();
    const player = createHtmlFillerPlayer({ makeAudio: fake.makeAudio, setTimer: timers.setTimer });
    const line: FillerLine = { id: 'think-1', kind: 'thinking', text: '我想想。' };
    const first = player.play(line);
    fake.made[0]!.el.onended?.(new Event('ended'));
    await first;
    const second = player.play(line);
    fake.made[0]!.el.onended?.(new Event('ended'));
    await second;
    expect(fake.made).toHaveLength(1);
    expect(fake.calls.filter((c) => c.startsWith('play:'))).toHaveLength(2);
  });

  it('掐的时候**淡出**再停,不是啪一下(硬切会「咔」一声,正好落在她开口之前)', () => {
    const fake = fakeAudio();
    const timers = fakeTimers();
    const player = createHtmlFillerPlayer({ makeAudio: fake.makeAudio, setTimer: timers.setTimer });
    void player.play({ id: 'think-1', kind: 'thinking', text: '我想想。' });
    const el = fake.made[0]!.el;
    const trail: number[] = [];
    player.stop();
    // 还没停:淡出是分几步走的,第一步也要等一个节拍。
    expect(fake.calls).not.toContain('pause:filler/think-1.m4a');
    for (let i = 0; i < 10; i += 1) {
      timers.fire();
      trail.push(el.volume);
    }
    // 一路降下去,降到 0 了才 pause —— 中间不许出现「还没降完就停了」。
    const untilPause = trail.slice(0, trail.findIndex((v) => v === 1) + 1 || trail.length);
    expect(untilPause.length).toBeGreaterThan(1);
    expect(untilPause[0]).toBeLessThan(1);
    expect(fake.calls).toContain('pause:filler/think-1.m4a');
    // pause 之后音量复位,下一句照样满音量(不然第二句会越来越小声)。
    expect(el.volume).toBe(1);
    // 整段淡出不超过 FILLER_FADE_MS(她那条字幕只比声音早 56–130ms,超了就会压上她的第一个字)。
    expect(timers.delays.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(FILLER_FADE_MS);
  });

  it('自动播放被拦 → reject,上面那一层据此只出字幕', async () => {
    const fake = fakeAudio();
    const player = createHtmlFillerPlayer({
      makeAudio: (url) => {
        const el = fake.makeAudio(url);
        (el as unknown as { play: () => Promise<void> }).play = () => Promise.reject(new Error('NotAllowedError'));
        return el;
      },
    });
    await expect(player.play({ id: 'think-1', kind: 'thinking', text: '我想想。' })).rejects.toThrow();
  });

  it('挂断把 `<audio>` 都放掉', async () => {
    const fake = fakeAudio();
    const player = createHtmlFillerPlayer({ makeAudio: fake.makeAudio });
    const playing = player.play({ id: 'think-1', kind: 'thinking', text: '我想想。' });
    fake.made[0]!.el.onended?.(new Event('ended'));
    await playing;
    player.dispose();
    expect(fake.calls).toContain('pause:filler/think-1.m4a');
  });
});
