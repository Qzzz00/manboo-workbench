/* 采集窗对齐速度谷（纯函数）：把证书判决的回卷对搬到内容最静的转移处。
 *
 * 背景（2026-07-10 「总不过关」诊断）：采集窗边界原本钉死在预热出口相位（相位 0），
 * 而相位 0 对内容活动量是任意的——双生 idle 恰好把动段尾压在窗边界上，回卷/中位
 * 基线 1.26 贴 1.3 门，吸引盆彩票（2T 亚谐波 +0.15）一中招就越线。极限环闭环下
 * 窗起点本就该是自由参数：侦察窗测出环形 MAD 谷（findLoopValleyIndex），第二窗
 * 从谷相位起采，回卷对=谷转移对，残差 δ 仍落在窗边界被如实判决（不藏缝）。
 */

export type AlignedWindow = {
  /** 第二窗首帧的绝对帧号（侦察窗为绝对帧 0..n-1；物理只前进不倒带） */
  startAbs: number;
};

/** n=周期帧数；valley=侦察窗环形 MAD 谷下标（mads[v]=帧 v-1→v 的转移）。
 * 第二窗覆盖相位 valley..valley+n-1 (mod n)，末帧→首帧 = 谷转移对。 */
export function planAlignedWindow(n: number, valley: number): AlignedWindow {
  return { startAbs: n + (((valley % n) + n) % n) };
}
