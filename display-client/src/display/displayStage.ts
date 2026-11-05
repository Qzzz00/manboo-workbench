/**
 * 展示台「形象位」放什么(2026-09-22,Ben 真机看过横屏展示台之后那句原话:
 * 「把 Live2D 形象换成旋转的粒子吧,后面我再给你对应的 Live2D 模型,再换上去」)。
 *
 * 所以这里是一个**开关**,不是一次替换 —— Live2D 那条路一行没删:
 *   · `?avatar=` 没有 / 是空串 / 是 `particles`(或 `particle` / `粒子`)→ 粒子球;
 *   · `?avatar=<形象 id>` → 还是原来那套 Live2D(HoloStage),一个参数都没改。
 * 换回 Live2D 的三步写在 docs/交接-0922-展示台粒子球.md,给不写代码的人看。
 *
 * 注意与 holoStage.ts 的 `resolveHoloAvatarId` 的差别:那一个「没写就回 null」,
 * 而展示台在没写时**还会去读 localStorage 里上次用过的形象**(lastAvatarStore)。
 * 09-22 之前「不带参数」=「上次那个形象」,现在「不带参数」=「粒子球」——
 * 这就是 Ben 要的默认值,`?avatar=` 是唯一的出口。
 */

/** `?avatar=` 写成这几个值之一 = 明写要粒子球(与不写一个意思,但看着更清楚)。 */
export const PARTICLE_AVATAR_VALUES: readonly string[] = ['particles', 'particle', '粒子'];

export type StageKind =
  /** 形象位是粒子球(默认)。 */
  | { kind: 'particles' }
  /** 形象位是 Live2D,用这个形象 id。 */
  | { kind: 'live2d'; avatarId: string };

/**
 * 形象位放什么。只看查询串,不看 localStorage —— 默认值必须是确定的一件事,
 * 不能「这台设备上次开过 hijiki 所以今天还是 hijiki」。
 *
 * `known`:指名的形象这台机器上有没有。仓库不带模型(2026-10-21),内置表是空的 ——
 * 没有就是粒子球,不白屏、不去网上找(1200×800 那台入口写死的 `?avatar=shuangsheng-p20` 就落在这里)。
 */
export function resolveStageKind(search: string, known: (id: string) => boolean = () => true): StageKind {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = params.get('avatar');
  const id = raw === null ? '' : raw.trim();
  if (id === '' || PARTICLE_AVATAR_VALUES.includes(id.toLowerCase()) || !known(id)) return { kind: 'particles' };
  return { kind: 'live2d', avatarId: id };
}

/**
 * 粒子球的态(2026-09-30 横屏补齐,维护者:「粒子的状态外面的也不一样」)。
 *
 * 09-22 那一版按「会话在不在 waiting / running」自己判,与手机竖屏首页、电脑首页各说各的:
 * 电脑上一条 waiting 的 Claude 会话球是白的,展示台上却是琥珀色。现在**照抄手机端**
 * `butler-app/src/swarm/orbState.ts` 的 `signalsFromState` + `stageModeOf`(去掉说话 / 聆听 ——
 * 展示台没人对它说话):
 *
 *   · 形状:有东西在跑(快照新鲜时;认服务端 `running.count`,老工作台退回数 sessions + 登记表)→ 莫比乌斯环;其余 → 球
 *   · 颜色:真出错(还开着的事项卡在出错上 / 派活失败,他停的不算)→ 红;
 *     等你(事务官问你的话、要你批的事、收件箱里等你拍板 / 有风险、引导那张单子没点头)→ 琥珀;其余中性
 *
 * 口径改了要两边一起改;字段全是工作台 `/state` 原样发来的,展示台不另算。
 */
export type StageParticleMode = 'idle' | 'working' | 'acknowledging';
export type StageParticleNotice = 'neutral' | 'confirmation' | 'failed';

/** 判球的态要看的那几格 `/state`。全是可选:老工作台没有的就当没有。 */
export interface OrbTaskLike {
  status?: string;
  direction?: string;
  kind?: string;
  assignee?: string;
  block_reason?: string;
  dispatch?: { status?: string; stopped?: unknown };
  client_dispatch?: { status?: string };
}
export interface OrbStateLike {
  stale: boolean;
  sessions: readonly { status: string }[];
  butler_inbox?: { items?: readonly { kind?: string }[] };
  materialize?: { status?: string };
  questions?: readonly unknown[];
  approvals?: readonly unknown[];
  tasks?: { tasks?: readonly OrbTaskLike[] };
  /** 服务端算好的「此刻在跑几件」(workbench-plugin/src/running.ts)。缺席 / 没 count = 数不出来,退回自己数。 */
  running?: { count?: number };
  agent_registry?: { entries?: readonly { status?: string; self?: boolean; gaps?: { status?: string }; sessions?: readonly { status: string }[] }[] };
}

export interface OrbSignals {
  working: boolean;
  attention: boolean;
  failed: boolean;
}

/** 事项收场了没有(办完 / 取消 / 等他验收)。同手机 orbState.ts 的 SETTLED。 */
const SETTLED: ReadonlySet<string> = new Set(['done', 'canceled', 'confirm']);

/** 同手机 / 工作台 `isTrackedItem`:交给事务官的,或看板上写了负责人的(选题卡不算)。 */
function isTracked(task: OrbTaskLike): boolean {
  if (task.direction === 'mine') return true;
  if (task.kind === 'topic') return false;
  return task.assignee !== undefined;
}

function isOpenFailure(task: OrbTaskLike): boolean {
  if (task.status !== undefined && SETTLED.has(task.status)) return false;
  return task.block_reason === 'error'
    || task.client_dispatch?.status === 'failed'
    || (task.dispatch?.status === 'failed' && task.dispatch.stopped === undefined);
}

/** 登记表里接上了的那几家有一条在跑(窗口型那几家、新家只在这里)。没接上的那家的旧数据不算。 */
function registryRunning(state: OrbStateLike): boolean {
  return (state.agent_registry?.entries ?? []).some((e) =>
    (e.self === true || (e.status !== 'unknown' && e.gaps?.status === undefined))
    && (e.sessions ?? []).some((s) => s.status === 'running'));
}

export function orbSignalsOf(state: OrbStateLike): OrbSignals {
  return {
    // 「在跑几件」全工作台一个数(电脑首页球下「执行 n」同源):有就只认它,老工作台没有才自己数。
    working: !state.stale && (typeof state.running?.count === 'number'
      ? state.running.count > 0
      : state.sessions.some((s) => s.status === 'running') || registryRunning(state)),
    attention: (state.butler_inbox?.items ?? []).some((item) => item.kind === 'confirm' || item.kind === 'risk')
      || (state.materialize !== undefined && state.materialize.status !== 'applied')
      || (state.questions?.length ?? 0) > 0
      || (state.approvals?.length ?? 0) > 0,
    failed: !state.stale && (state.tasks?.tasks ?? []).some((task) => isTracked(task) && isOpenFailure(task)),
  };
}

export function particleModeOf(signals: OrbSignals): { mode: StageParticleMode; notice: StageParticleNotice } {
  // 有在跑的:形状一律是莫比乌斯环,等你 / 出错只换颜色(2026-10-01 维护者:「有运行中的卡片时候,粒子球应该是旋转的莫比乌斯环」)。
  if (signals.working) return { mode: 'working', notice: signals.failed ? 'failed' : signals.attention ? 'confirmation' : 'neutral' };
  if (signals.failed) return { mode: 'acknowledging', notice: 'failed' };
  if (signals.attention) return { mode: 'acknowledging', notice: 'confirmation' };
  if (signals.working) return { mode: 'working', notice: 'neutral' };
  return { mode: 'idle', notice: 'neutral' };
}

/**
 * 展示台的态 → 核心(core.js)认的态。同手机 `CORE_MODE`:
 * 在办交核心原版的 working 形(莫比乌斯环,2026-09-24 傍晚维护者:「就用莫比乌斯环,但是没有光团的版本」);
 * 等你 / 出错还是球(交 idle,只换颜色;2026-09-18「又是黄色的笑脸」那条规矩)。
 */
export const STAGE_CORE_MODE: Record<StageParticleMode, string> = { idle: 'idle', working: 'working', acknowledging: 'idle' };

/**
 * 「旋转」这件事本身。
 *
 * 核心的运动参数里本来就有 `spinSpeed`(「左右自转 · 负数反向」,默认 0.3 rad/s),
 * 而且**只在 idle 态生效**(core.js:`this.mode==='idle'?settings.spinSpeed:0`)。
 * 所以不给核心加任何新东西:Mac 那份外观里 spinSpeed 是多少,展示台就转多快。
 *
 * 唯一的兜底:Mac 上把它调成了 0(不转),展示台仍然要转 —— Ben 要的就是「旋转的粒子」。
 * 这时候给一档慢速自转。**可推翻**:不想要这个兜底,把这个函数删掉、直接用 settings 即可。
 */
export const STAGE_FALLBACK_SPIN = 0.18;

export function withStageSpin(settings: Readonly<Record<string, number>>): Record<string, number> {
  const spin = settings.spinSpeed;
  if (typeof spin === 'number' && Math.abs(spin) >= 0.02) return { ...settings };
  return { ...settings, spinSpeed: STAGE_FALLBACK_SPIN };
}

/**
 * 粒子球能不能在这个环境里跑起来(2026-09-22)。
 *
 * 抽成纯函数的理由:display-client 的测试全是 node 环境的纯逻辑,没有 jsdom、没有 testing-library
 * (liveStore.ts 里那段注释写的就是这条仓库约定)。把「什么时候该退回占位球」这个判断
 * 单独拎出来,就能在既有约定下把它覆盖住,而不必为渲染一个组件往仓库塞两个新依赖。
 * 组件那一侧只剩一句 `if (reason !== null) 退回占位球`。
 *
 * 回 null = 能跑;回一句话 = 退回占位球,并把这句话写进 console(真机上按前缀找得到)。
 */
export interface ParticleEnvironment {
  /** canvas 节点在不在(React ref 挂上了没有)。 */
  hasNode: boolean;
  /** 这个环境里有没有 CanvasRenderingContext2D 这个类(jsdom / 很老的 WebView 没有)。 */
  hasContextClass: boolean;
  /** `canvas.getContext('2d')` 的返回值(取不到 2D 上下文时是 null)。 */
  context: unknown;
}

export function particleUnavailableReason(env: ParticleEnvironment): string | null {
  if (!env.hasNode) return '没有 canvas 节点';
  if (!env.hasContextClass) return '这个环境里没有 CanvasRenderingContext2D(jsdom / 很老的 WebView)';
  if (env.context === null || env.context === undefined) return '这块 canvas 给不出 2D 上下文';
  return null;
}

/**
 * 交给核心的那一份参数(2026-09-30):**中心光团一律关**(`cloudSize = 0`,核心里「大小 · 0 为关闭」),
 * 与手机 `phoneOrbSettings` / `sceneSettings` 同一个口径 —— 09-23 维护者说的「被压成长方形横带,中间还有一团光」,
 * 展示台一直没跟上,横屏上那颗球就是那条横带。自转兜底照旧(`withStageSpin`)。不改入参。
 */
export function displayOrbSettings(settings: Readonly<Record<string, number>>): Record<string, number> {
  return { ...withStageSpin(settings), cloudSize: 0 };
}

/**
 * 展示台底图(Live2D 那条路原样:两张,双击切换;配色跟着翻)。
 * 实测平均亮度 02=64(暗)/ 01=209(亮),亮底图必须配深色字。
 */
export const DISPLAY_BACKGROUNDS: readonly { url: string; scheme: 'dark' | 'light' }[] = [
  { url: '/backgrounds/display-bg.jpg', scheme: 'dark' },
  { url: '/backgrounds/display-bg-2.jpg', scheme: 'light' },
];

/**
 * 这块屏底下铺什么(2026-09-30,维护者看着手机横屏:「还有那个壁纸,你看不到问题吗」)。
 *
 * 那两张是 Aiboo 时期给 Live2D 角色配的动漫房间图;09-22 换成粒子球之后仍然铺着,
 * 而 09-24 两端已经定了「一律深色、中性、去蓝」(手机底 #0f0f0f、电脑同源)。
 * 所以**粒子那条路不铺图**、配色恒深;Live2D 那条路(`?avatar=`,那是给角色配的场景)一字不动。
 */
export function stageBackdrop(stage: StageKind, bgIndex: number): { url: string | null; scheme: 'dark' | 'light' } {
  if (stage.kind === 'particles') return { url: null, scheme: 'dark' };
  const one = DISPLAY_BACKGROUNDS[bgIndex] ?? DISPLAY_BACKGROUNDS[0];
  return { url: one.url, scheme: one.scheme };
}

/**
 * 宽扁屏(手机横屏 873×393 一类,宽高比 ≈ 2.2)走三栏排法。
 * 稿子是 1200×800(1.5);按宽缩放后手机上设计高度只剩 ~540,v4 那套「上时钟音乐、中会话、下额度」
 * 竖着摞三层,中间的会话区被挤成只剩一个标题(2026-09-30 浏览器 873×393 实测)。
 * 门槛 1.75:展示台那台 788×493(1.6)与 1200×800 都还是老排法。
 */
export const WIDE_ASPECT = 1.75;
export function isWideScreen(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return width / height >= WIDE_ASPECT;
}

/**
 * 横屏展示台用哪一套(2026-10-01,维护者:「设置里面新增一个展示台样式的选项……选中哪个,横屏就显示哪个」)。
 * 手机壳按 设置 › 声音与形象 › 展示台样式 拼 `?layout=`:`orbit` = 第二套「环绕」(Pen.dev 稿,Codex 画),
 * 其余 = 原来那套。那台 1200×800 桌面展示台不带这个参数,照旧。
 */
export type DisplayLayout = 'classic' | 'orbit';

export function resolveDisplayLayout(search: string): DisplayLayout {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('layout') === 'orbit' ? 'orbit' : 'classic';
}
