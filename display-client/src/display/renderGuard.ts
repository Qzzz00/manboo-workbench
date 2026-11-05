/**
 * 形象舞台的自救规则(2026-10-01,维护者真机:「左右切换模型容易显示不出来,我现在是触发横屏竖屏之后才能恢复渲染,
 * 还出现过黑色剪影」)。纯函数,packRenderer / AvatarStage 用。
 *
 * 三个坑:
 *   · 同一个模型同时载了两份(换完壳又递一次列表、或来回快滑回到正在显示的那个):贴图按地址缓存成**同一份**,
 *     作废的那份放手时把它销毁了 → 上屏那份画成一团黑影(pixi-live2d-display 碰到失效贴图直接跳过不绑);
 *   · 一帧渲染抛错:PIXI 的 ticker 在 update 里抛错就不再排下一帧,整条循环停死,直到转屏换一块新画布;
 *   · 手机上内存紧时 WebGL 上下文丢失:这块画布再也画不出东西。
 * 对策:同一个不重载;贴图记账、没人用了才销毁;渲染包 try/catch;卡住 / 丢上下文就重建画布再载一次。
 */

export const STALL_MS = 2_500;

export function isSameAvatar(a: { id: string; base: string }, b: { id: string; base: string }): boolean {
  return a.id === b.id && a.base === b.base;
}

export interface StallInput {
  now: number;
  /** 最后一次**成功**画出一帧的时刻。 */
  lastFrameAt: number;
  /** 模型上屏的时刻(刚上屏给点余量)。 */
  shownSince: number;
  /** 页面可见且舞台有尺寸。 */
  visible: boolean;
  /** 正在显示一个形象(不是粒子球)。 */
  showing: boolean;
  lost: boolean;
}

export function isStalled(s: StallInput): boolean {
  if (!s.visible || !s.showing) return false;
  if (s.lost) return true;
  if (s.now - s.shownSince < STALL_MS) return false;
  return s.now - s.lastFrameAt >= STALL_MS;
}

/**
 * 贴图记账:每个上过手的模型 retain 一次它的贴图,放手时 release,回到 0 的才销毁。
 * 同一个模型同时载两份(壳又递了一次列表就会这样)时两份拿到的是同一批缓存贴图 —— 只按「新旧两个」比是不够的。
 */
export function createTextureLedger<T>() {
  const counts = new Map<T, number>();
  return {
    retain(list: readonly T[]) {
      for (const t of new Set(list)) counts.set(t, (counts.get(t) ?? 0) + 1);
    },
    release(list: readonly T[]): T[] {
      const free: T[] = [];
      for (const t of new Set(list)) {
        const had = counts.get(t);
        if (had === undefined) continue; // 没记过账(已经放过了):不是这里该销毁的
        if (had <= 1) { counts.delete(t); free.push(t); } else counts.set(t, had - 1);
      }
      return free;
    },
  };
}
