/**
 * 展示台 Live2D 形象的待机动作调度(2026-10-01)。
 *
 * 维护者:「可别现在做完是一堆贴图啊,碧蓝航线的应该有很多动作,可以随机播放,那 4 个之前让写了动作的,
 * 但是可能比较呆板,你可以再丰富看看」。
 *
 * 规则(纯函数,渲染那一层照它播):
 *   · 一条「待机循环」一直在底下播(idle*);
 *   · 每隔 12–30 秒随机插一段(不连着重复同一段),播完回到循环;
 *   · 碧蓝那批的插播用游戏里主界面 / 来信 / 任务那几段;**婚礼、特效、各种触摸反应不进随机**
 *     (触摸反应是点到角色身上才有的,没人点的屏上自己冒出来不对;婚礼段太长、太特殊);
 *   · **「回港」「登录」是运镜**(10-01 实测:镜头飞到无人机视角、上下黑边、仪表 HUD,播完 HUD 还残留),一律不播;
 *     8 个角色每段都按画面筛过(和待机画面比差异:角色动作 1–16,运镜 30–155),个别角色另外筛出的运镜段
 *     (71 更衣间的 idle1 / idle2 / idle4 / mission)由形象包清单传进来排除;
 *   · 那几段原本配着语音、嘴在对口型,这里没有声音 —— 播的时候把嘴压住(`muteMouth`),不像在默念。
 */

export interface IdlePlan {
  /** 待机循环(多条时随机挑一条循环,下一次换)。 */
  loop: string[];
  /** 随机插播。 */
  beats: string[];
  /** 播的时候把嘴(ParamMouthOpenY)压到 0。 */
  muteMouth: boolean;
}

const LOOP = /(^|\/)idle\d*\.motion3\.json$/i;
const BEAT = /(^|\/)(main_\d+|mail|mission|mission_complete|complete)\.motion3\.json$/i;

export function azurIdlePlan(files: readonly string[], exclude: readonly string[] = []): IdlePlan {
  const usable = files.filter((f) => !exclude.includes(f));
  const loop = usable.filter((f) => LOOP.test(f));
  const beats = usable.filter((f) => BEAT.test(f));
  return { loop: loop.length > 0 ? loop : beats.slice(0, 1), beats, muteMouth: true };
}

/** 下一段插播:随机,但不连着两次同一段。 */
export function nextBeat(beats: readonly string[], last: string | null, rand: () => number): string | null {
  if (beats.length === 0) return null;
  const pool = beats.length > 1 && last !== null ? beats.filter((b) => b !== last) : beats;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

export const BEAT_DELAY_MIN_MS = 12_000;
export const BEAT_DELAY_MAX_MS = 30_000;

/** 两次插播之间隔多久。 */
export function beatDelayMs(rand: () => number): number {
  return Math.round(BEAT_DELAY_MIN_MS + (BEAT_DELAY_MAX_MS - BEAT_DELAY_MIN_MS) * rand());
}
