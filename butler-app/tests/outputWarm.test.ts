/**
 * **把通话的音频输出真的烘热**(2026-09-28,卡 OP)。
 *
 * 卡 CF 第 4 条那一版判「真的在放了」靠的是「一个新建的 `AudioContext` 的时钟在走」——
 * 那个时钟一建就在走,与「Android WebView 把通话音频路由切过去、AudioTrack 重开」毫无关系。
 * 于是手机在**开喇叭那一刻**就报「我在放了」,而它真正出声还要几百毫秒;维护者从手机打出去,
 * 听到的还是「何吩咐」(前面约 0.8 秒被吃)。
 *
 * 这一份的判据换成**这台机器的输出真的在消化音频**:经同一个输出播一小段静音,
 * 看那个元素的 `currentTime` 是不是真的在往前走(媒体时钟由输出设备的播放位置推动 ——
 * 路由没热、AudioTrack 没起来,它一动不动),推进够了再给一个余量,才算热了。
 *
 * 四条纪律,缺一条就会变成新的毛病:
 *   · 判不出来(没有可播的输出、起播被拒)→ **当场算过**,绝不把接通变慢;
 *   · 有上限(缺省 {@link WBCH_OUTPUT_WARM_MS}),到点照样往下打;
 *   · 热了之后那一小段静音**不立刻停**(停了 AudioTrack 可能被回收、下一下又要重开)——
 *     交一个 `release()` 给通话那一层,等她真的出声了 / 挂断了再停;
 *   · 判不出来的那两支也要把那一小段静音收干净。
 */
import { describe, expect, it } from 'vitest';
import {
  WBCH_OUTPUT_PROGRESS_MS,
  WBCH_OUTPUT_SETTLE_MS,
  WBCH_OUTPUT_WARM_MS,
  warmOutput,
  type WarmSinkLike,
} from '../src/call/outputWarm';

/** 一台手动推进的计时器。 */
function timers() {
  const pending: { fn: () => void; at: number }[] = [];
  let clock = 0;
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, at: clock + ms };
      pending.push(entry);
      return () => { const at = pending.indexOf(entry); if (at >= 0) pending.splice(at, 1); };
    },
    /** 往前走,顺手把到点的都叫一遍(每次只叫一轮,够用了)。 */
    advance(ms: number) {
      clock += ms;
      for (const entry of [...pending]) {
        if (entry.at > clock) continue;
        pending.splice(pending.indexOf(entry), 1);
        entry.fn();
      }
    },
  };
}

/** 一个假的输出:`tick()` 才推它的媒体时钟(路由没热的时候它一动不动)。 */
function fakeSink(play?: () => Promise<void> | void) {
  const state = {
    currentTime: 0,
    played: 0,
    paused: 0,
    play: play ?? (() => { state.played += 1; }),
    pause: () => { state.paused += 1; },
    tick: (ms: number) => { state.currentTime += ms / 1000; },
  };
  return state as WarmSinkLike & typeof state;
}

describe('通话输出烘热了才请她开口', () => {
  it('媒体时钟真的推进 + 余量 → 才算热了(路由切换那一段里不算)', async () => {
    const t = timers();
    const sink = fakeSink();
    const warming = warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10 });
    // 前 200ms 输出一动不动(正在切通话路由、重开 AudioTrack)—— 一下都不许算过。
    t.advance(200);
    sink.tick(WBCH_OUTPUT_PROGRESS_MS);
    t.advance(10);
    // 推进够了还要等那个余量,这会儿还没热。
    t.advance(WBCH_OUTPUT_SETTLE_MS);
    const outcome = await warming;
    expect(outcome.how).toBe('warm');
    // 真的出声是在第 210ms,热了是再加一个余量之后。
    expect(outcome.progressMs).toBe(210);
    expect(outcome.waitedMs).toBe(210 + WBCH_OUTPUT_SETTLE_MS);
  });

  it('热了之后那一小段静音不立刻停,交 release() 给通话那一层', async () => {
    const t = timers();
    const sink = fakeSink();
    const warming = warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10 });
    sink.tick(WBCH_OUTPUT_PROGRESS_MS);
    t.advance(10);
    t.advance(WBCH_OUTPUT_SETTLE_MS);
    const outcome = await warming;
    expect(outcome.how).toBe('warm');
    expect(sink.paused).toBe(0);
    outcome.release();
    expect(sink.paused).toBe(1);
    // 再叫一次不许再停一遍(挂断与「她出声了」两条路都会叫它)。
    outcome.release();
    expect(sink.paused).toBe(1);
  });

  it('输出一直不出声 → 到点照样往下打,并且把那一小段静音收干净', async () => {
    const t = timers();
    const sink = fakeSink();
    const warming = warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10 });
    t.advance(WBCH_OUTPUT_WARM_MS);
    const outcome = await warming;
    expect(outcome.how).toBe('timeout');
    expect(outcome.waitedMs).toBe(WBCH_OUTPUT_WARM_MS);
    expect(outcome.progressMs).toBeUndefined();
    expect(sink.paused).toBe(1);
  });

  it('推进了但余量还没走完就到点 → 算热了(真的出声过)', async () => {
    const t = timers();
    const sink = fakeSink();
    const warming = warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10, warmMs: 100, settleMs: 500 });
    sink.tick(WBCH_OUTPUT_PROGRESS_MS);
    t.advance(10);
    t.advance(100);
    const outcome = await warming;
    expect(outcome.how).toBe('warm');
    expect(outcome.progressMs).toBe(10);
  });

  it('这台机器造不出输出 → 当场算过,不把接通变慢', async () => {
    const t = timers();
    const outcome = await warmOutput({ makeSink: () => undefined, now: t.now, setTimer: t.setTimer });
    expect(outcome.how).toBe('skipped');
    expect(outcome.waitedMs).toBe(0);
  });

  it('造输出抛了也当场算过', async () => {
    const t = timers();
    const outcome = await warmOutput({ makeSink: () => { throw new Error('no Audio'); }, now: t.now, setTimer: t.setTimer });
    expect(outcome.how).toBe('skipped');
  });

  it('起播被拒(自动播放被拦)→ 当场算过,不干等到上限', async () => {
    const t = timers();
    const sink = fakeSink(() => Promise.reject(new Error('NotAllowedError')));
    const outcome = await warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10 });
    expect(outcome.how).toBe('skipped');
    expect(sink.paused).toBe(1);
  });

  it('上限设成 0 = 不烘(逐字回到上一版,一下都不等)', async () => {
    const t = timers();
    const sink = fakeSink();
    const outcome = await warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, warmMs: 0 });
    expect(outcome.how).toBe('skipped');
    expect(outcome.waitedMs).toBe(0);
    expect(sink.played).toBe(0);
  });

  it('读 currentTime 抛了(元素被拆了)→ 算过,不吊死', async () => {
    const t = timers();
    const sink = {
      play: () => {},
      pause: () => {},
      get currentTime(): number { throw new Error('detached'); },
    } as unknown as WarmSinkLike;
    const warming = warmOutput({ makeSink: () => sink, now: t.now, setTimer: t.setTimer, pollMs: 10 });
    t.advance(10);
    expect((await warming).how).toBe('skipped');
  });
});
