/**
 * 座机来电在手机这一侧的**状态**(2026-09-21,Ben:「待确认 / 运行失败 / 完成提醒时座机响铃,
 * 用户接起来处理事务」)。
 *
 * 这个文件里**全是纯函数**:消息进、状态出。响铃在 call/ringtone.ts,界面在 IncomingCallPage.tsx,
 * 进房与接线在 call/useIncoming.ts —— 分开的理由和 fillerAudio / fillerPlayer 那一对一样:
 * 状态机要能在单测里跑完,不用假装有 `<audio>`、有原生插件。
 *
 * ## 一通来电只有三个样子
 *
 *   idle → ringing(响着,全屏来电页)→ answered(接起来了,进通话)→ idle
 *
 * **「正在接起」不是单独一格,是 ringing 上的一个标记 `answering`**(2026-09-23 晚):
 * 按下「接起」那一下先停铃、打上标记;工人的回话或者「接起来了」广播谁先到都进 answered;
 * 回话说没接上就退回。以前没有这个标记,广播先到就被当成「别人接的」(真机没声那一次)。
 *
 * ## 三条边角,每一条都真会发生
 *
 * 1. **响着的时候又来一通**:后来的那通**不顶掉**正响的这通(工人那边本来就排队,
 *    正常不会发生;真发生了说明工人重启过)。谁先到谁在屏幕上。
 * 2. **他按「接起」的同一刻铃超时了**:工人回一句「正在响的不是这一通」,
 *    这时手机已经在 answered 了 —— 所以接起要**等工人那一声**才真的进通话(见 useIncoming)。
 * 3. **silent 的那一条压根不进这个状态机**:它不是来电,是一条通知(夜间静默时段)。
 */
import type { WbchCallState, WbchRing, WbchRingEnd } from '../channel/channelProtocol';

/** 为什么打。与 workbench-plugin 的 `CALL_OUT_REASON_TITLES` **逐字相同**。 */
export const RING_REASON_TITLES: Record<WbchRing['reason'], string> = {
  confirm: '等你确认',
  failed: '运行失败',
  done: '完成',
  ask: '等你回答',
  // 2026-09-27(卡 CB):你让她捎进某条会话的那句话,那边回了 —— 或者等太久还没回。
  relay: '回话来了',
};

/** 来电页上那一行小字,说清接起来会发生什么。 */
export const RING_REASON_HINTS: Record<WbchRing['reason'], string> = {
  confirm: '接起来可以直接说「批准」或者「打回去重做」',
  failed: '接起来可以让事务官重做一次,也可以先放着',
  done: '接起来听听办完了什么',
  ask: '接起来直接说你的意思;不方便就挂了,首页「等你确认」里点一下',
  // 这一通只是转述,不用他决定什么 —— 那句话下面写的就是这个意思。
  relay: '接起来听那边回了什么;不方便就挂了,回话在「未接来电」里留着',
};

export interface IncomingCall {
  call_id: string;
  reason: WbchRing['reason'];
  item_id: string;
  title: string;
  note?: string;
  at: string;
  merged?: readonly { item_id: string; title: string }[];
  /** 响到这个时刻为止(毫秒)。到点手机自己也收掉来电页,不只等工人那条 ring_end。 */
  until: number;
}

/**
 * 2026-09-22(座机界面)多了第四个样子 `handset`:**这一通是树莓派上那只实体话筒接起来的**。
 *
 * 怎么认出来的:工人在**任何人**按下接起时都广播一条 `ring_end{outcome:'answered'}`
 * (channel-worker/src/callOut.ts 的 `answer()`)。这台手机自己按的那一次,状态已经是
 * `answered`,那条只是回声(下面第 2 条边角);而**屏幕还在响的时候**收到这一条,
 * 就只能是房里的另一台设备接的 —— 座机形态下那正是话筒(决策记录 2026-09-21
 * 「座机形态」:提机之后通话音频走树莓派,**手机只显示字幕与按钮**)。
 *
 * 为什么不等一条新信号:树莓派那张卡刻意**没有**加 `offhook`/`onhook`,理由写在
 * `docs/交接-0921-树莓派话筒进房.md` 第三节 ——「`answer`/`hangup` 就是同一个状态机的
 * 同两个入口」。协议一个字不动,手机自己认得出来。
 *
 * **反过来那一半 2026-09-22 补上了**(待拍板 E1,按统筹建议做):话筒挂机时工人广播一条
 * `ring_end{outcome:'hung_up'}`(channel-worker/src/callOut.ts 的 `hangup(by)`),
 * 这一屏据此**自己收掉**,他的手不用碰手机 —— 座机的整个意思就在这一下。
 * 这台手机自己按的挂断**不会**收到那一条(工人不发回声),所以不存在收两次。
 */
export type IncomingState =
  | { kind: 'idle' }
  /**
   * `answering`(2026-09-23 晚,维护者真机「手机接起来之后没声、不收音」):**这台手机刚按了接起,
   * 正等工人回话**。工人那边是先广播 `ring_end{answered}` / `call_state`、后回 RPC 的,
   * 而同一条通道按序读 —— 广播**先到**。没有这一格时,响铃中听到「接起来了」一律被当成
   * 「另一台设备接的」,于是他自己接的这一通被画成字幕页(不放音不收音),回话到时已经不认了。
   * 有这一格,这段时间里的 answered / in_call 就认作**自己这次接起**。RPC 回失败再退回。
   */
  | { kind: 'ringing'; call: IncomingCall; answering?: true }
  | { kind: 'answered'; call: IncomingCall }
  /**
   * **别人接的那一通**。`by` 是**哪一台接的**(2026-09-22 晚,工人在
   * `ring_end{outcome:'answered'}` 里明着写了):`'handset'` = 树莓派上那只实体话筒,
   * `'phone'` = 房里另一台手机。老工人不带这一格,那时是 `undefined` ——
   * 座机形态下按话筒说(那是 0921 那条推断的原意),界面上的措辞据此变。
   *
   * 不管是哪一台,这台手机的动作**一模一样**:只显示字幕与挂断,
   * **不放她的声音、不推自己的麦克风**。谁接谁说话。
   */
  | {
    kind: 'handset';
    /**
     * 这一通是为哪件事打来的。**他自己提机拨出去的那一通没有**(2026-09-23):
     * 那通没有铃、没有 call_id、也不为哪一件事 —— 屏上就只写「话筒通话中」,
     * 不编一个事项出来。
     */
    call?: IncomingCall;
    by?: 'handset' | 'phone';
    /**
     * 这一通从什么时候起(毫秒,工人报的)。屏上那行「从 HH:MM 起」读它。
     * 老工人(只发 `ring_end`、不发 `call_state` 的那版)不带,那时那一行只写「话筒通话中」。
     */
    since?: number;
  };

export type IncomingEvent =
  | { type: 'ring'; ring: WbchRing }
  /** `self` = 这台手机进房的 identity(拿来和工人广播里的 `by_identity` 比;不知道就不带)。 */
  | { type: 'ring_end'; end: WbchRingEnd; self?: string }
  /**
   * **这会儿房里在不在通话里**(2026-09-23,「打进打出同一张页」)。
   * 拨出那条路上这是**唯一**的信号(它没有 ring、没有 ring_end)。
   */
  | { type: 'call_state'; state: WbchCallState; self?: string }
  /** 他按下了「接起」,还在等工人回话(乐观标记,见 `ringing.answering`)。 */
  | { type: 'answering' }
  /** 工人回话:接上了。 */
  | { type: 'answer' }
  /** 工人回话:没接上(铃刚好超时 / 别人先接了)。乐观标记退回。 */
  | { type: 'answer_failed' }
  /** 他按了「稍后」,或者挂断了这通已接的电话。 */
  | { type: 'dismiss' }
  /** 铃响够了(手机自己的倒计时)。 */
  | { type: 'timeout'; now: number };

export const IDLE: IncomingState = { kind: 'idle' };

export function callOfRing(ring: WbchRing): IncomingCall {
  return {
    call_id: ring.call_id,
    reason: ring.reason,
    item_id: ring.item_id,
    title: ring.title,
    ...(ring.note === undefined ? {} : { note: ring.note }),
    at: ring.at,
    ...(ring.merged === undefined ? {} : { merged: ring.merged }),
    until: ring.until,
  };
}

/**
 * **这一声「接起来了」是不是我自己这次接起**(2026-09-23 晚)。
 *
 * 1. 工人带了 `by_identity`、我也知道自己是谁 → **只看这一条**(新工人,不靠猜);
 * 2. 否则看我是不是刚按了接起(`answering`):按了,而且工人没明说是话筒 → 是我;
 * 3. 都不是 → 不是我(0921 那条推断:我还响着却收到 answered = 别人接的)。
 */
export function answeredBySelf(state: IncomingState, by: { by?: string; by_identity?: string }, self?: string): boolean {
  if (by.by_identity !== undefined && self !== undefined && self !== '') return by.by_identity === self;
  return state.kind === 'ringing' && state.answering === true && by.by !== 'handset';
}

/**
 * 一条消息 / 一次按键 → 下一个状态。**认不出来就原样返回**(同一个对象,
 * 这样 React 不会为了一条无关的消息重画来电页)。
 */
export function reduceIncoming(state: IncomingState, event: IncomingEvent): IncomingState {
  if (event.type === 'ring') {
    // 夜间静默那一条不是来电,是一条通知 —— 它根本不该走到这儿(useIncoming 先挡掉),
    // 挡漏了也不许让它响。
    if (event.ring.silent) return state;
    // 已经在响 / 已经在通话:后来的那通不顶掉屏幕上这一通。
    if (state.kind !== 'idle') return state;
    return { kind: 'ringing', call: callOfRing(event.ring) };
  }
  if (event.type === 'call_state') {
    /**
     * **打进与打出同一张页**(2026-09-23,Ben 12:45:「打过来和打过去都应该是显示同一个页面」)。
     *
     * 三条规矩,每一条都有理由:
     *
     * 1. **只认 `by:'handset'` 的 `in_call`**。手机自己拨 / 自己接的那一通由它自己那条路管
     *    (`answer` → `answered` → 舞台页的通话态),再被一条广播顶一次只会把它的通话搅了。
     * 2. **已经在这一面上就原样返回同一个对象**。工人那边虽然幂等,但广播会因为掉线重连
     *    再送一遍;返回同一个对象 React 才不会重画 —— 而他正看着字幕。
     *    **只有一个例外**:来电那条路上 `ring_end{answered}` 通常先到(它带不了「从几点起」),
     *    随后那条 `call_state` 是**这一面唯一一次**能拿到起始时刻的机会。补上它不是重画一遍,
     *    是把缺的那一格填上;填过之后再来多少条都原样返回。
     * 3. **`idle` 只收得掉这一面**。响着的铃、自己接起的那一通都不归它管
     *    (铃有 `ring_end`,自己那通有自己的挂断)。
     */
    if (event.state.state === 'idle') return state.kind === 'handset' ? IDLE : state;
    /**
     * 我刚按了接起、工人说「这一通在通话里了、是我」(广播先于回话到,2026-09-23 晚):
     * 直接进自己的通话,别等回话,更别落进字幕页。
     */
    if (state.kind === 'ringing' && (event.state.call_id === undefined || event.state.call_id === state.call.call_id)
      && answeredBySelf(state, event.state, event.self)) {
      return { kind: 'answered', call: state.call };
    }
    if (event.state.by !== 'handset') return state;
    if (state.kind === 'handset') {
      const since = event.state.started_at > 0 ? event.state.started_at : undefined;
      if (since === undefined || state.since !== undefined) return state;
      return { ...state, since };
    }
    // 自己接起来的那一通不归它管(那条路有自己的挂断),一条广播不许把它搅了。
    if (state.kind === 'answered') return state;
    // 还在响的时候它先到(两条广播谁先到都可能):把正响的这一通带进这一面,铃自己就停了。
    return {
      kind: 'handset',
      ...(state.kind === 'ringing' ? { call: state.call } : {}),
      by: 'handset',
      ...(event.state.started_at > 0 ? { since: event.state.started_at } : {}),
    };
  }
  if (event.type === 'ring_end') {
    if (state.kind === 'idle') return state;
    // 他自己拨出去的那一通没有 call_id:任何一条 ring_end 都不是它的,一条都收不掉它。
    if (state.call === undefined) return state;
    if (state.call.call_id !== event.end.call_id) return state;
    /**
     * **`hung_up` = 这通已接的电话结束了**(2026-09-22,待拍板 E1)。
     *
     * 今天只有两条路会发它:树莓派话筒挂机、工人发现房里没人了自己补的那一刀。
     * 两条都是「屏上这一面该收了」,所以不管这会儿是 `handset` 还是 `answered`
     * 一律回待机 —— **本地通话态跟着一起结束**(App.tsx 据 kind 决定画哪一屏)。
     * 还在响的时候收到它不可能(没接起来的电话挂不了),真收到了也照收:铃该停。
     */
    if (event.end.outcome === 'hung_up') return IDLE;
    // 「他接起来了」这条是工人对我们自己那次接起的回声 —— 已经在通话里就别把它收掉。
    if (state.kind !== 'ringing' && event.end.outcome === 'answered') return state;
    /**
     * **还在响的时候听见「接起来了」= 房里另一台设备接的**(2026-09-22)。
     * 座机形态下那是树莓派上那只话筒:通话音频走它,手机这一屏改成字幕 + 挂断。
     *
     * 2026-09-22 晚:工人现在把**是谁接的**写在 `by` 里,不必再靠推断。
     * 推断那一条仍然留着(老工人不带 `by`),但它只决定**屏上那句话怎么写**;
     * 「这一通不归我出声」这个结论两条路都一样 —— 我还响着,就说明接的不是我。
     */
    if (state.kind === 'ringing' && event.end.outcome === 'answered') {
      // ★ 2026-09-23 晚:**是我自己按的那一次**(广播先于回话到)→ 进自己的通话(开喇叭开麦)。
      if (answeredBySelf(state, event.end, event.self)) return { kind: 'answered', call: state.call };
      return { kind: 'handset', call: state.call, ...(event.end.by === undefined ? {} : { by: event.end.by }) };
    }
    return IDLE;
  }
  if (event.type === 'answering') {
    if (state.kind !== 'ringing' || state.answering === true) return state;
    return { ...state, answering: true };
  }
  if (event.type === 'answer') {
    // 广播先到、已经进了通话:回话只是确认,原样返回。
    if (state.kind !== 'ringing') return state;
    return { kind: 'answered', call: state.call };
  }
  if (event.type === 'answer_failed') {
    /**
     * 没接上:**只收掉我自己的乐观那一格**。已经被别人接走(`handset`)的那一面不归这一下收 ——
     * 那是房里真在进行的一通,字幕页该留着。
     */
    if (state.kind === 'ringing' || state.kind === 'answered') return IDLE;
    return state;
  }
  if (event.type === 'dismiss') {
    if (state.kind === 'idle') return state;
    return IDLE;
  }
  // timeout:只收响着的那一通。已经接起来的电话不会因为「铃响够了」被挂掉。
  // 他已经按了接起、正等工人回话:也不收 —— 收不收由那一声回话定(铃超时工人会回失败)。
  if (state.kind !== 'ringing' || state.answering === true) return state;
  return event.now >= state.call.until ? IDLE : state;
}

// ———————————————————————— 未接来电 ————————————————————————

/** `GET /call/log` 回来的一条(只留手机要显示的那几样)。 */
export interface CallLogEntry {
  id: string;
  reason: WbchRing['reason'];
  item_id: string;
  title: string;
  note?: string;
  at: string;
  state: string;
  ended_at?: string;
  error?: string;
  /**
   * 这一条未接他**已经收过了**(服务端 `POST /call/missed/clear` 写的时刻,2026-09-22)。
   * 有这一格就不再进未接列表 —— 但**它还在 `entries` 里**:台账一条没删,
   * 座机页「最近一次通话」读的是同一本。
   */
  dismissed_at?: string;
  /**
   * `failed` 是哪一种(2026-10-12,与工作台 `CallOutEntry.fail_kind` 同值):技术失败 / 她停了铃 / 已无需再打 / 不明。
   * 只有技术失败算失败。手机眼下不列 `failed` 那几条,先原样带上,统计与以后的列表照它分。
   */
  fail_kind?: CallLogFailKind;
}

export const CALL_LOG_FAIL_KINDS = ['tech', 'declined', 'moot', 'unknown'] as const;
export type CallLogFailKind = (typeof CALL_LOG_FAIL_KINDS)[number];

export interface CallLogView {
  entries: readonly CallLogEntry[];
  missed: number;
  /**
   * 「完成」那一类此刻**会不会真打电话**(服务端 `/call/config` 的 `done_call`,缺省关着)。
   *
   * 为什么在这儿:`GET /call/log` 的回包里本来就带一份 `config`(workbench-plugin 的
   * `callOut.view()` 返回 `{config, entries, missed}`),手机**不用再问一条** —— 未接列表
   * 要显示什么,和这一本台账是同一次问答里拿到的,不会出现「列表新、开关旧」。
   *
   * **读不到就是 false**(保守):宁可不给「回拨」,也不要给一颗点下去必被拒的键。
   */
  doneCall: boolean;
}

/** 把 `/call/log` 的回包读成能画的东西。**读不懂就当没有**,绝不抛(它从网上来)。 */
export function parseCallLog(raw: unknown): CallLogView {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(body.entries) ? body.entries : [];
  const entries = rows.flatMap((one) => {
    const row = (one ?? {}) as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.title !== 'string') return [];
    const reason = row.reason;
    if (reason !== 'confirm' && reason !== 'failed' && reason !== 'done' && reason !== 'ask' && reason !== 'relay') return [];
    return [{
      id: row.id,
      reason,
      item_id: typeof row.item_id === 'string' ? row.item_id : '',
      title: row.title,
      ...(typeof row.note === 'string' && row.note !== '' ? { note: row.note } : {}),
      at: typeof row.at === 'string' ? row.at : '',
      state: typeof row.state === 'string' ? row.state : '',
      ...(typeof row.ended_at === 'string' ? { ended_at: row.ended_at } : {}),
      ...(typeof row.dismissed_at === 'string' && row.dismissed_at !== '' ? { dismissed_at: row.dismissed_at } : {}),
      ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
      ...((CALL_LOG_FAIL_KINDS as readonly unknown[]).includes(row.fail_kind) ? { fail_kind: row.fail_kind as CallLogFailKind } : {}),
    } satisfies CallLogEntry];
  });
  const config = (typeof body.config === 'object' && body.config !== null ? body.config : {}) as Record<string, unknown>;
  return {
    entries,
    // **不自己数**:服务端那个 missed 是整本台账的,手机这边只拿到最近几十条。
    missed: typeof body.missed === 'number' && Number.isFinite(body.missed) ? body.missed : entries.filter(one => one.state === 'missed').length,
    // 没带 config、或者那一格不是个布尔 → 当成关着(见 CallLogView 上面那段)。
    doneCall: config.done_call === true,
  };
}

/**
 * 未接的那几条(最近的在前 —— `/call/log` 本来就是这个顺序,这里不再排一遍)。
 *
 * **收过的不算**(2026-09-22):他在手机上按过「清空」的那几条带 `dismissed_at`,
 * 台账里照旧留着,只是不再挂在他眼前。口径与服务端那个 `missed` 数逐条相同。
 */
export function missedCalls(log: CallLogView): readonly CallLogEntry[] {
  return log.entries.filter(entry => entry.state === 'missed' && entry.dismissed_at === undefined);
}

// ——— 折叠:同一件事的多次未接只占一行(2026-09-22) ———

/**
 * 一组未接:**同一件事的同一个理由**的那几通(真机上「下班例程」一口气九条)。
 *
 * 为什么按 `reason + item_id` 分:这正是服务端「一件一通」去重(`liveCallFor`)的那把钥匙,
 * 也是回拨时要发过去的那两样。同一张卡先「运行失败」后「完成」是**两件事**,
 * 两行分开 —— 它们要回拨的是不同的电话。
 *
 * `item_id` 读不出来(老台账、坏行)时退回用标题分,**不把两件不相干的事并成一行**。
 */
export interface MissedGroup {
  key: string;
  reason: CallLogEntry['reason'];
  item_id: string;
  title: string;
  /** 最近那一通。回拨、给不给键、点不点得动**全按它算**。 */
  latest: CallLogEntry;
  /** 这一组全部,最近的在前(展开时列的就是它)。 */
  entries: readonly CallLogEntry[];
  count: number;
}

export function missedGroupKey(entry: Pick<CallLogEntry, 'reason' | 'item_id' | 'title'>): string {
  return `${entry.reason}\u0000${entry.item_id === '' ? entry.title : entry.item_id}`;
}

export function missedGroups(log: CallLogView): readonly MissedGroup[] {
  const groups: MissedGroup[] = [];
  const index = new Map<string, number>();
  for (const entry of missedCalls(log)) {
    const key = missedGroupKey(entry);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, groups.length);
      // 第一条就是最近那一条(列表本来就是最近在前),不再比时刻 —— 时刻可能读不出来。
      groups.push({ key, reason: entry.reason, item_id: entry.item_id, title: entry.title, latest: entry, entries: [entry], count: 1 });
      continue;
    }
    const group = groups[at]!;
    groups[at] = { ...group, entries: [...group.entries, entry], count: group.count + 1 };
  }
  return groups;
}

/**
 * **首页上挂出来的那几组未接**(2026-10-03,卡「首页侧边小图标」)。
 *
 * 口径与原来写在 MissedCalls 里那一行逐字相同:已经收场的事(取消了 / 办完了)引起的未接不挂
 * (`hideItems`,统筹 09-25 晚);没挂在事项上的那几条(`item_id` 为空)照旧挂。
 *
 * **为什么搬成一处**:侧边那颗图标上的角标数和点开之后列出来的那几行必须是同一个数。
 * 两处各数一遍早晚会出「角标写 2、点开只有一行」—— 角标是她唯一能一眼看到的那个数,错了比没有更糟。
 */
export function missedShownGroups(log: CallLogView, hideItems?: ReadonlySet<string>): readonly MissedGroup[] {
  return missedGroups(log).filter((group) => group.item_id === '' || hideItems?.has(group.item_id) !== true);
}

/** 挂出来的那几组一共几通(侧边图标的角标、点开之后标题里那个数,都是它)。 */
export function missedShownCount(log: CallLogView, hideItems?: ReadonlySet<string>): number {
  return missedShownGroups(log, hideItems).reduce((sum, group) => sum + group.count, 0);
}

/**
 * 未接来电里**留着的那一句**(2026-09-27,卡 CB)。
 *
 * 只有「回话来了」那一类有:那一句就是**那边回的原话**(工作台从窗口里原样读回来的,
 * 没经模型改写)。他没接起那通电话,这一句就是他唯一能看到回话的地方 —— 所以它必须在
 * 未接里留着,而不是随那通电话一起消失。别的几类没有这一行(它们的内容在事项上)。
 */
export function missedSayText(entry: Pick<CallLogEntry, 'reason' | 'note'>): string | null {
  if (entry.reason !== 'relay') return null;
  const note = entry.note?.trim() ?? '';
  return note === '' ? null : note;
}

/**
 * 首页那一行(收着的未接)写什么:「最近:回话来了 Claude「统筹交接」」。
 * 「回话来了」那一类**把那句回话也接在后面** —— 首页那一行就看得到原话(放不下由 CSS 省略号收尾)。
 */
export function missedLatestText(group: Pick<MissedGroup, 'reason' | 'title' | 'latest'>): string {
  const head = `最近:${RING_REASON_TITLES[group.reason]} ${group.title}`;
  const say = missedSayText(group.latest);
  return say === null ? head : `${head} · ${say}`;
}

/** 折叠那一行右边的小字:「未接 7 次 · 最近 17:06」。只有一通就只写时刻(不说「未接 1 次」)。 */
export function missedGroupSummary(group: MissedGroup): string {
  const time = callTimeText(group.latest.at);
  if (group.count <= 1) return time;
  return time === '' ? `未接 ${group.count} 次` : `未接 ${group.count} 次 · 最近 ${time}`;
}

/**
 * 「眼前这一批未接」的指纹。两处面板的「清空」按下去先**当场收起**,靠的就是它:
 * 记下按的那一下是哪一批,下次台账变了(清掉了 / 又来了新的一通)指纹就不同,
 * 面板自己回来 —— **不是一按就永久关掉**(那正是 0.2.56 之前「知道了」的毛病)。
 */
export function missedIdsKey(log: CallLogView): string {
  return missedCalls(log).map(one => one.id).join(',');
}

/** 顶上那一行。一条都没有就是 null(**不显示「未接来电 0」**)。 */
export function missedBannerText(log: CallLogView): string | null {
  const count = log.missed;
  return count > 0 ? `未接来电 ${count}` : null;
}

/**
 * 这一行**给不给「回拨」键**(2026-09-22)。
 *
 * 规矩只有一条:`done_call` 关着的时候,「完成」那几行不给 —— 服务端的 `POST /call/out`
 * 对它们是**必拒**的(workbench-plugin/src/server/callOut.ts 的 `request()`),
 * 一颗点下去必被拒的键比没有这颗键更糟:他会以为是坏了。
 *
 * 「等你确认」「运行失败」两类一个字没变,`done_call` 开着时「完成」也照旧回拨得了。
 */
export function canCallBack(log: CallLogView, entry: Pick<CallLogEntry, 'reason'>): boolean {
  return entry.reason !== 'done' || log.doneCall;
}

/** 不给「回拨」时那一行小字。**说清后果 + 去哪儿开**,和服务端那句拒绝话同一个去处。 */
export const CALL_BACK_DONE_OFF_TEXT = '只发通知 · 设置 → 座机 可打开';

/**
 * 这一件事的这一个理由,此刻有没有一通**还没收场**的电话(排着 / 正在响)。
 *
 * 口径与服务端 `liveCallFor` **逐条相同**(`queued` / `ringing` 两档;`missed` / `answered` /
 * `notified` / `failed` 都算收场)。服务端拒「这一件正在响,没有再排一通」靠的就是它 ——
 * 手机照同一条判,于是那颗键在**还没收场**的这段时间里是灰的:他点不出第二通,
 * 也不用先挨一句拒绝才知道。收场之后(台账再拉一次)自己就亮回来。
 */
export function hasLiveCall(log: CallLogView, entry: Pick<CallLogEntry, 'reason' | 'item_id'>): boolean {
  return log.entries.some(one =>
    (one.state === 'queued' || one.state === 'ringing')
    && one.reason === entry.reason
    && one.item_id === entry.item_id);
}

/**
 * 「14:03」,从**毫秒时刻**来的那一种(2026-09-23,通话页上那行「从 HH:MM 起」)。
 * 读不出来就空字符串 —— 同 {@link callTimeText},**不编一个时刻**。
 */
export function clockTextOfMs(at?: number): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 「14:03」。读不出来就空字符串 —— 不编一个时刻。 */
export function callTimeText(at: string): string {
  const stamp = Date.parse(at);
  if (Number.isNaN(stamp)) return '';
  const date = new Date(stamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
