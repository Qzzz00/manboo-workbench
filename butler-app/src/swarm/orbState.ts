/**
 * 手机主界面粒子球的状态映射(2026-09-16)。五态与电脑端 ParticleOrb 同一套语义:
 *   待命 idle / 聆听 listening / 在办 working / 说话 speaking / 需要你 acknowledging(+ 琥珀色 notice)
 * 外加引导页用的 说话准备 preparing(事务官在想、话还没出口;2026-09-16 开场体验)。
 * 优先级:说话 > 聆听 > 在办(颜色随出错 / 需要你)> 需要你 > 说话准备 > 待命——嘴上在说就是说话态,不被别的盖掉;
 * 有东西在跑时形状不让位(2026-10-01,全平台一致:电脑首页也是「执行 n > 0 就是环」,只有打字时变在听)。
 */
import type { TaskView, WorkbenchState } from '../api/protocol';
import { trackedTasks } from '../items/itemsModel';
import type { Tuning } from './core.js';

export type StageMode = 'idle' | 'listening' | 'working' | 'speaking' | 'acknowledging' | 'preparing';
export type StageNotice = 'neutral' | 'confirmation' | 'completed' | 'failed';

export interface StageSignals {
  /** 正在朗读 / 播放事务官的话。 */
  speaking: boolean;
  /** 录音中 / 文字输入中。 */
  listening: boolean;
  /** 事务官那侧有在办的会话(DSH running),或引导会话正在回话。 */
  working: boolean;
  /** 收件箱里有等你的事。 */
  attention: boolean;
  /**
   * 有一件**还开着**的事真出错了、还没处理(2026-09-25 晚):球变红。与电脑首页同一个口径 ——
   * 红色只用于真错误;取消了、办完了的不算,未接来电不算。缺省不红。
   */
  failed?: boolean;
  /** 引导里事务官在想(该它说话而还没说):说话准备态。 */
  thinking?: boolean;
}

export function stageModeOf(signals: StageSignals): { mode: StageMode; notice: StageNotice } {
  if (signals.speaking) return { mode: 'speaking', notice: 'neutral' };
  if (signals.listening) return { mode: 'listening', notice: 'neutral' };
  // 真出错(还开着、没处理)排在「等你确认」前面:两样都有时先说出错(同电脑首页 failed > confirmation)。
  // 有在跑的:形状一律是莫比乌斯环,等你 / 出错只换颜色(2026-10-01 维护者:「有运行中的卡片时候,粒子球应该是旋转的莫比乌斯环」)。
  // 在想(刚发出去还没回)也不压过它 —— 只要有东西在做就是环(2026-10-01「全平台都是一致的」)。
  if (signals.working) {
    return { mode: 'working', notice: signals.failed === true ? 'failed' : signals.attention ? 'confirmation' : 'neutral' };
  }
  if (signals.failed === true) return { mode: 'acknowledging', notice: 'failed' };
  if (signals.attention) return { mode: 'acknowledging', notice: 'confirmation' };
  if (signals.thinking === true) return { mode: 'preparing', notice: 'neutral' };
  if (signals.working) return { mode: 'working', notice: 'neutral' };
  return { mode: 'idle', notice: 'neutral' };
}

/**
 * 主页(事项对话)的信号:从 /state 快照来。
 *
 * **2026-10-04(卡「球的颜色一处算」):提示色与在办与否只认 `/state.orb`** —— 工作台用
 * `workbench-plugin/src/orbCell.ts` 的 `orbCellOf` 算好的那一格,电脑首页那颗球读的是同一格。
 * 维护者 10-04(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、颜色比如状态」——
 * 根子就是这个函数与电脑端各自从 /state 推算(这里的 `failed` 是「有一件**还开着**的事出过错」,含历史阻塞 => 永久红;
 * 电脑 0.4.96 已经改成「只认此刻正在执行的那件出错」)。
 *
 * `speaking` / `listening` / `thinking` 是**本机交互态**(说话、收音、在想),电脑没有这几样,照旧本地算、照旧叠在上面。
 * 老工作台没有 `/state.orb` 时下面那几条本地推算原样留着,行为与 0.4.96 一字不差。
 */
export function signalsFromState(state: WorkbenchState, extra: { speaking: boolean; listening: boolean }): StageSignals {
  const cell = state.orb;
  if (cell !== undefined) {
    return {
      speaking: extra.speaking,
      listening: extra.listening,
      // 在办与否、红 / 琥珀全照那一格;`stageModeOf` 的优先级(说话 > 聆听 > 在办)照旧在本机定。
      working: cell.working,
      attention: cell.notice === 'confirmation',
      failed: cell.notice === 'failed',
    };
  }
  return {
    speaking: extra.speaking,
    listening: extra.listening,
    // 2026-09-25(统筹转维护者:「codex 和 Claude 都有会话在跑,它说 0 执行」):各家客户端有一条在跑也算在办 ——
    // 与电脑首页球周围的「正在办」、首页「正在办」那块卡同一个口径。快照不新鲜(电脑没连上)时不凭旧数据说在办。
    // 登记表里接上了的那几家有一条在跑也算(窗口型那几家、新家只在这里)。
    // 2026-10-01「全平台都是一致的」:「在跑几件」认服务端那一个数(电脑首页球下「执行 n」同源,含事务官在执行的事项);
    // 老工作台没有这一格才自己数(老 sessions + 登记表里接上了的那几家)。
    working: !state.stale && (typeof state.running?.count === 'number'
      ? state.running.count > 0
      : state.sessions.some((s) => s.status === 'running')
        || (state.agent_registry?.entries ?? []).some((e) => (e.self === true || (e.status !== 'unknown' && e.gaps?.status === undefined))
          && e.sessions.some((s) => s.status === 'running'))),
    // 2026-09-18 Ben:一进主页就是黄色笑脸——原来收件箱里有任何一条(含例程生成的汇报)都算「需要你」。
    // 只有等你拍板/有风险的那两类才算;会话卡、哨兵卡不是在等人。
    // 2026-09-25 晚:引导落地那张单子等他点头时也算(它就在「等你确认」那一格置顶)。
    attention: (state.butler_inbox?.items ?? []).some((item) => item.kind === 'confirm' || item.kind === 'risk')
      || (state.materialize !== undefined && state.materialize.status !== 'applied')
      // 事务官问你的话、要你批的事(2026-09-25,卡 M):那件事正停下来等你,球跟「等你确认」一样亮琥珀。
      || (state.questions?.length ?? 0) > 0 || (state.approvals?.length ?? 0) > 0,
    // 事项(卡 N:他交给事务官的 + 看板上写了负责人的)里有一件还开着的真出错了 → 红。与电脑首页同一个口径。
    failed: !state.stale && trackedTasks(state).some(isOpenFailure),
  };
}

/** 事项收场了没有(办完 / 取消 / 等他验收):收场了的,之前出过的错不再算「没处理」。 */
const SETTLED: ReadonlySet<string> = new Set(['done', 'canceled', 'confirm']);

/**
 * 一件还开着的事**真出错了**:卡在「出错」上(block_reason error),或者派给别家没派出去 / 没做成
 * (client_dispatch / dispatch 的 failed)。与电脑首页 butlerSceneModel 同一条判据(2026-09-25 晚,
 * 统筹:「红色只用于真错误 —— 有真失败且还没处理才红,待确认琥珀,其余中性」)。
 */
export function isOpenFailure(task: TaskView): boolean {
  if (SETTLED.has(task.status)) return false;
  // 卡 O:他停的 / 到时长上限先停下来的那一次派活(`dispatch.stopped`)不是出错,不染红。
  return task.block_reason === 'error' || task.client_dispatch?.status === 'failed' || (task.dispatch?.status === 'failed' && task.dispatch.stopped === undefined);
}

/**
 * 场景(2026-09-23,维护者:「手机上的引导模式也是一样的,现在中间有光团」)。与电脑端
 * workbench-plugin/src/client/particleScene.ts `sceneSettings` 同一个口径。
 *
 * **2026-09-23 第二轮从零重装之后:中心光团在手机上一律关掉**(维护者两次提到舞台页「中间还有一团光」,
 * 明确说不要)。不再分场景 —— 舞台、来电、登录、引导、通话全都 `cloudSize = 0`(核心里「大小 · 0 为关闭」),
 * 只剩粒子本身。场景这一格留着,老调用方照传不报错。**不动 Mac 那份外观参数**,只压渲染时那一格。
 *
 * 在想(`preparing`)另外一份(见 {@link phoneOrbSettings}):球形不变,节奏提上去。
 * 在办(`working`)交核心原版的 working 形(莫比乌斯环;2026-09-24 傍晚恢复,光团照关)。
 */
export type ParticleSceneKind = 'workbench' | 'onboarding';
export function sceneSettings(settings: Tuning, _scene: ParticleSceneKind = 'workbench'): Tuning {
  if (settings.cloudSize !== 0) return { ...settings, cloudSize: 0 };
  return settings;
}

/** 「在想」时的自转(rad/s,核心上限)与漂移下限。与电脑端当年 onboarding-busy 那一档同值。 */
export const BUSY_SPIN = 1;
export const BUSY_DRIFT = 1.8;

/**
 * 手机上交给核心的那一份参数(2026-09-23 第二轮从零重装,维护者:舞台页的球「被压成长方形横带,中间还有一团光」)。
 *
 * - 光团:一律关(同 {@link sceneSettings})。
 * - 在想(`preparing`):借的 `speaking` 轮廓会一鼓一鼓,所以**核心照跑待命(球形)**,
 *   自转拉到上限 {@link BUSY_SPIN}(方向跟用户那一项)、漂移至少 {@link BUSY_DRIFT} 倍。核心一个字不改(它与电脑端逐字同源)。
 * - 在办(`working`):**2026-09-24 傍晚起交核心原版的 working 形(莫比乌斯环)**,参数只关光团。
 *   09-23 那次一度也把它改成「待命 + 转快」,维护者 09-24 傍晚澄清:「我当时的讲法,只是不要中间的光团……
 *   就用莫比乌斯环,但是没有光团的版本」—— 「长方形横带」那一眼,是中间那团光把带子压成了一块。
 * - 说话:照交核心的 `speaking`(球形 + 随音节轻微起伏、亮度随之变),不另加东西。
 *
 * 不改入参;没有要改的就返回同一个引用(ParticleStage 按引用判断要不要重新 configure)。
 */
export function phoneOrbSettings(settings: Tuning, mode: StageMode): Tuning {
  const base = sceneSettings(settings);
  if (mode !== 'preparing') return base;
  const spin = settings.spinSpeed ?? 0.3;
  return { ...base, spinSpeed: spin < 0 ? -BUSY_SPIN : BUSY_SPIN, drift: Math.max(settings.drift ?? 1, BUSY_DRIFT) };
}

/**
 * 手机的态 → 核心(core.js)认的态。核心与 Mac 逐字同源,不给它加态。
 * 在办交核心的 working 形(莫比乌斯环,光团关;2026-09-24 傍晚恢复);在想走待命(球形,节奏由 {@link phoneOrbSettings} 提上去);
 * 「需要你」不再让球变成一张笑脸(2026-09-18 维护者两次说「又是黄色的笑脸」):球还是球,只用琥珀色说「有事等你」。
 */
export const CORE_MODE: Record<StageMode, string> = { idle: 'idle', listening: 'listening', working: 'working', speaking: 'speaking', acknowledging: 'idle', preparing: 'idle' };
