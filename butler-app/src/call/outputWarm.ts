/**
 * **把这台机器的通话音频输出真的烘热**(2026-09-28,卡 OP),烘热了再请她开口。
 *
 * ## 病根(这一份替掉的是什么)
 *
 * 卡 CL:开喇叭 → 等 `play()` 那个 promise 回来 → 请工人开口。`play()` 几十毫秒就 resolve,
 * 但它只表示「浏览器接下了这次播放」。
 *
 * 卡 CF 第 4 条:改成手机自己判「真的在放了」再报一条 `call.playing`,工人的开场白等它。
 * 判据两条,谁先到算谁 —— 其中一条是「**一个新建的 `AudioContext` 的时钟在走**」。
 * **这一条是错的**:那个 context 没有连任何输出节点、也没有源在放,`currentTime` 一 `resume()`
 * 就在走,与「Android WebView 把音频路由切到通话、AudioTrack 重开」毫无关系。于是:
 *
 *   · 手机在**开喇叭那一刻**(40ms 左右)就报「我在放了」;
 *   · 而拨出那一路是**先开喇叭、后发 `call.start`** —— 那条 `playing` 比接起先到,
 *     工人那道闸当时把先到的丢掉、随后又把「报过了」抹掉,于是白等到 2.5s 上限;
 *   · 真机日志(0.4.55,Pixel 10 → 维护者本机,18:1x)里一行「在放了」都没有,
 *     只有卡 CL 那句「对端订上工人音轨了(等了 0ms),开口」。维护者听到的是「何吩咐」。
 *
 * ## 这一份的判据:输出真的在消化音频
 *
 * 接通那一刻,经**同一个音频输出**播一小段静音(通话那一层给的 `makeSink`),看那个元素的
 * `currentTime` 是不是真的在往前走。媒体元素的时钟由**输出设备的播放位置**推动 ——
 * 路由还在切、AudioTrack 还没起来的时候它一动不动;它开始走的那一刻,正是「喇叭真的在出声」。
 * 推进够 {@link WBCH_OUTPUT_PROGRESS_MS} 之后再给 {@link WBCH_OUTPUT_SETTLE_MS} 的余量,才算热了。
 *
 * **热了之后那一小段静音不立刻停**:停了这条 AudioTrack 可能被回收,她的第一帧到的时候又要重开一次
 * —— 那就是原样的病。所以交一个 `release()` 给通话那一层,等**她真的出声了**(远端 `<audio>` 报出进度)
 * 或者挂断、到了兜底的时限再停。
 *
 * ## 四条纪律
 *
 * 1. 判不出来(这台机器造不出输出、起播被拒、元素被拆了)→ **当场算过**,绝不把接通变慢;
 * 2. 有上限 {@link WBCH_OUTPUT_WARM_MS},到点照样往下打(宁可第一个字有风险,也不能打不通);
 * 3. 哪一支都要把那一小段静音收干净(`release()` 或内部自己停);
 * 4. 等了多久、什么时候真的出声,都原样报出去(`waitedMs` / `progressMs`)——
 *    工人把它写进日志,统筹真机核的就是那一行。取不到就缺席,不编一个数。
 *
 * 纯逻辑:输出与计时器都是注入的,用例里不需要真的出声。
 */

/** 只用到这几样(用例里塞一个假的;真的那一个是 `<audio>`,见 livekitCall.ts 的 makeSilentSink)。 */
export interface WarmSinkLike {
  play?: () => Promise<void> | void;
  pause?: () => void;
  currentTime?: number;
}

/**
 * 输出的媒体时钟**真的往前走了这么久**才算「在出声」(毫秒)。
 * 40ms 太容易被一次计时抖动蒙对,80ms ≈ 四五个音频块,已经不可能是假的。
 */
export const WBCH_OUTPUT_PROGRESS_MS = 80;

/**
 * 真的出声之后再给路由这么久的**余量**(毫秒)。
 *
 * 为什么还要余量:`currentTime` 开始走只说明这条轨起来了,通话路由刚切过去的头一小段
 * 在真机上仍可能丢帧。被吃掉的那一截约 800ms,工人前面已经垫了 260ms 静音(greeting.ts),
 * 而烘热本身(`progressMs`,真机上每通都进日志)量掉的正是路由那一段 —— 余量只需要盖住轨道自己的爬升。
 *
 * **这个数是个起点,不是实测结论**:真机核的时候看工人日志里那句「它自己烘热输出等了 NNNms」,
 * 第一个字还被吃就把它加大(通话那一层的 `outputSettleMs` / 这里的缺省值)。
 */
export const WBCH_OUTPUT_SETTLE_MS = 180;

/** 烘热最多等这么久(毫秒)。到点照样往下打 —— 这一条治的是「第一个字被吃」,不许把它变成「打不通」。 */
export const WBCH_OUTPUT_WARM_MS = 1200;

/** 多久看一次输出的时钟(毫秒)。 */
export const WBCH_OUTPUT_POLL_MS = 20;

/** 烘热这一下怎么收的。 */
export type WarmHow =
  /** 输出真的在出声了(判据成立)。 */
  | 'warm'
  /** 到点还没出声,照样往下打。 */
  | 'timeout'
  /** 判不出来(造不出输出、起播被拒、上限设成了 0)—— 当场算过。 */
  | 'skipped';

export interface WarmOutcome {
  how: WarmHow;
  /** 从开始烘到收场一共多久。 */
  waitedMs: number;
  /** 输出**第一次真的在出声**是第几毫秒(判出来了才有;没判出来就缺席)。 */
  progressMs?: number;
  /** 那一小段静音停掉。**可以叫好几次**(挂断与「她出声了」两条路都会叫)。 */
  release: () => void;
}

export interface WarmOutputDeps {
  /** 造一小段能循环播的静音(同一个音频输出)。回 undefined / 抛了 = 判不出来 → 当场算过。 */
  makeSink?: () => WarmSinkLike | undefined;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  pollMs?: number;
  progressMs?: number;
  settleMs?: number;
  warmMs?: number;
}

const noop = (): void => { /* 没什么要停的 */ };

export async function warmOutput(deps: WarmOutputDeps = {}): Promise<WarmOutcome> {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => { clearTimeout(timer); };
  });
  const pollMs = Math.max(1, deps.pollMs ?? WBCH_OUTPUT_POLL_MS);
  const needMs = Math.max(0, deps.progressMs ?? WBCH_OUTPUT_PROGRESS_MS);
  const settleMs = Math.max(0, deps.settleMs ?? WBCH_OUTPUT_SETTLE_MS);
  const warmMs = Math.floor(deps.warmMs ?? WBCH_OUTPUT_WARM_MS);
  const startedAt = now();

  // 不烘(逐字回到上一版):一下都不等,连那一小段静音都不造。
  if (warmMs <= 0) return { how: 'skipped', waitedMs: 0, release: noop };

  let sink: WarmSinkLike | undefined;
  try { sink = deps.makeSink?.(); }
  catch { sink = undefined; }
  if (sink === undefined) return { how: 'skipped', waitedMs: 0, release: noop };

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { sink?.pause?.(); } catch { /* 元素被拆了就算了 */ }
  };

  /** 起播被拒(自动播放被拦)= 判不出来:别干等到上限。放成了的话这条永远不 resolve。 */
  let tellRefused: (() => void) | undefined;
  const refused = new Promise<void>((r) => { tellRefused = r; });
  try {
    const started = sink.play?.();
    if (started !== undefined && started !== null) {
      void Promise.resolve(started).catch(() => { tellRefused?.(); });
    }
  }
  catch {
    release();
    return { how: 'skipped', waitedMs: Math.max(0, now() - startedAt), release: noop };
  }

  return await new Promise<WarmOutcome>((resolve) => {
    let done = false;
    let cancelPoll: (() => void) | undefined;
    let cancelSettle: (() => void) | undefined;
    let cancelDeadline: (() => void) | undefined;
    let hotAt: number | undefined;

    const finish = (how: WarmHow): void => {
      if (done) return;
      done = true;
      try { cancelPoll?.(); } catch { /* 取消定时器失败不值得再出一个错 */ }
      try { cancelSettle?.(); } catch { /* 见上 */ }
      try { cancelDeadline?.(); } catch { /* 见上 */ }
      // 热了就把那一小段静音留着(别让 AudioTrack 被回收);没热就当场收干净。
      if (how !== 'warm') release();
      resolve({
        how,
        waitedMs: Math.max(0, now() - startedAt),
        ...(hotAt === undefined ? {} : { progressMs: hotAt }),
        release: how === 'warm' ? release : noop,
      });
    };

    /** 到点:真的出声过就算热了(余量没走完不算白等),一下都没出声才算 timeout。 */
    cancelDeadline = setTimer(() => { finish(hotAt === undefined ? 'timeout' : 'warm'); }, warmMs);

    void refused.then(() => { finish('skipped'); });

    const poll = (): void => {
      if (done) return;
      let at: number | undefined;
      // 元素被拆了(读 currentTime 抛了)→ 判不出来,别吊死。
      try { at = sink?.currentTime; }
      catch { finish('skipped'); return; }
      if (typeof at === 'number' && at * 1000 >= needMs) {
        hotAt = Math.max(0, now() - startedAt);
        // 真的在出声了 —— 再给路由那个余量,然后算热。
        cancelSettle = setTimer(() => { finish('warm'); }, settleMs);
        return;
      }
      cancelPoll = setTimer(poll, pollMs);
    };
    poll();
  });
}
