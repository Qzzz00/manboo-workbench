import { bakeIdle, type BakeRuntime, type BakeProgress } from './bakeIdle.ts';
import { WIDGET_VIEW, widgetProfileFor, capFrames } from './widgetProfile.ts';

/**
 * 桌面组件烤帧（运行时层）：bakeIdle → 帧数上限保护 → 背景合成 → PNG base64。
 * 复用 bakeIdle 机制（唯一真相源）；纯函数常量在 widgetProfile.ts。
 */

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** cover 语义画背景（裁切铺满），失败回纯色底。 */
function drawBackground(ctx: CanvasRenderingContext2D, bg: HTMLImageElement | null, w: number, h: number) {
  if (!bg || !bg.naturalWidth) {
    ctx.fillStyle = '#1a1d2a';
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const s = Math.max(w / bg.naturalWidth, h / bg.naturalHeight);
  const dw = bg.naturalWidth * s;
  const dh = bg.naturalHeight * s;
  ctx.drawImage(bg, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export type WidgetBakeOutput = { framesPng: string[]; fps: number };

/**
 * 烤一个组件动画环：帧含背景（不透明），base64 不含 dataURL 前缀。
 */
export async function bakeWidgetLoop(
  runtime: BakeRuntime,
  motionUrl: string | null,
  bgUrl: string,
  onProgress?: (p: BakeProgress) => void,
  durationS?: number,
): Promise<WidgetBakeOutput> {
  const result = await bakeIdle(runtime, widgetProfileFor(motionUrl, durationS), onProgress);
  // 环的真正起点在 startIdx（采集窗对齐到速度谷）：吧唧固件按 start_idx 起播（abpPack），
  // 而 ViewFlipper 只会从 children[0] 顺播——必须旋转数组把接缝对到谷点。
  // 不旋转 = 每圈中段一次硬跳变（v1 起所有"卡"的真凶，与帧率无关）。
  const rot = result.frames.length ? result.startIdx % result.frames.length : 0;
  const aligned = rot > 0
    ? [...result.frames.slice(rot), ...result.frames.slice(0, rot)]
    : result.frames;
  let capped = capFrames(aligned, result.fps);
  // 摆动环（无 authored 闭环保证）走乒乓回放：正放+倒放（去首尾重复帧）拼环，
  // 结构性零接缝——预热截断(warmupMaxCycles=6)导致的首尾不闭合从此无影响。
  if (!motionUrl && capped.frames.length > 2) {
    capped = { frames: [...capped.frames, ...capped.frames.slice(1, -1).reverse()], fps: capped.fps };
  }
  const bg = await loadImage(bgUrl);
  const { w, h } = WIDGET_VIEW;

  const framesPng: string[] = [];
  for (const frame of capped.frames) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    drawBackground(ctx, bg, w, h);
    ctx.drawImage(frame, 0, 0, w, h);
    framesPng.push(canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));
  }
  return { framesPng, fps: capped.fps };
}
