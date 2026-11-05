/* 吧唧工坊图形化缩略图（UI 层，独立于 badgeBake 烘焙机制）。
 *
 * 两类缩略图，全部走引擎真渲染（后台无角色头像资源，模型目录里的图不统一）：
 * - 角色头像：屏外 466 容器现渲一帧（与吧唧同取景），缩到 144px 存 localStorage，
 *   一次生成永久缓存；面板已加载的 runtime 优先「顺手」抓，避免为头像重复加载大模型。
 * - 动作缩略图：借面板 live runtime，把候选动作在中段时刻的参数经 afterMotionUpdate
 *   钩子写入（与烘焙同一注入位，物理之前），推进一帧后抓图——用户看到的是动作
 *   真实中段姿态，不是术语文案。仅内存缓存（每次进面板重生成，<200ms）。
 */
import * as PIXI from 'pixi.js';
import { resolveAvatarManifestById } from '../features/live2d/avatarManifest.ts';
import { createLive2DRuntime, destroyRuntime } from '../features/live2d/live2dEngine.ts';
import { evalMotionParams, parseMotion3 } from '../tools/badgeExport/motionCurves.ts';

type AnyRuntime = Awaited<ReturnType<typeof createLive2DRuntime>>;

type InternalHooks = {
  on?: (event: string, fn: () => void) => void;
  off?: (event: string, fn: () => void) => void;
  coreModel: {
    setParameterValueById: (id: string, value: number) => void;
    getParameterValueById?: (id: string) => number;
  };
};

/** 钩子写参→推帧→抓图→**复原**。抓图的直写会进参数保存表（loadParameters 会回放它），
 * 不复原=所有候选的参数残留叠加（实测：烤出来兔子玩偶+麦克风+问号全上身）；引擎
 * overlay 只管理自己表情层的参数，不会帮直写擦屁股。 */
function withHookedWrites(
  runtime: AnyRuntime,
  writes: Array<[string, number]>,
  size: number,
): string | null {
  const internal = runtime.model.internalModel as unknown as InternalHooks;
  const core = internal.coreModel;
  const saved: Array<[string, number]> = writes.map(([id]) => {
    let v = 0;
    try { v = core.getParameterValueById?.(id) ?? 0; } catch { /* 未知参数 */ }
    return [id, v];
  });
  const write = () => {
    for (const [id, v] of writes) {
      try { core.setParameterValueById(id, v); } catch { /* 未知参数：忽略 */ }
    }
  };
  internal.on?.('afterMotionUpdate', write);
  try {
    // 推 3 帧让二级物理（头发/翅膀）跟到目标姿态附近，缩略图更像真实观感
    for (let i = 0; i < 3; i += 1) advanceOnce(runtime, 1000 / 60);
    return extractStage(runtime, size);
  } finally {
    internal.off?.('afterMotionUpdate', write);
    const restore = () => {
      for (const [id, v] of saved) {
        try { core.setParameterValueById(id, v); } catch { /* ignore */ }
      }
    };
    internal.on?.('afterMotionUpdate', restore);
    try { advanceOnce(runtime, 1000 / 60); } catch { /* ignore */ }
    internal.off?.('afterMotionUpdate', restore);
  }
}

const PORTRAIT_KEY = (avatarId: string) => `aiboo:badge-thumb:v1:${avatarId}`;
const PORTRAIT_SIZE = 144;
const MOTION_THUMB_SIZE = 176;
const STAGE_SIZE = 466;   // 与吧唧取景一致（BADGE_PROFILE_BASE.view），头像=吧唧构图缩影

/** 把当前舞台渲成 size×size 的 dataURL（暗底 JPEG，取景=466 恒等，与吧唧成品同构图）。
 * 页面在后台时 WebGL 停绘/回读=全透明（与烘焙空帧同源危害）——空图返回 null，绝不入缓存。 */
function extractStage(runtime: AnyRuntime, size: number): string | null {
  const renderer = runtime.app.renderer as PIXI.Renderer;
  const rt = PIXI.RenderTexture.create({ width: STAGE_SIZE, height: STAGE_SIZE, resolution: 1 });
  renderer.render(runtime.app.stage, { renderTexture: rt });
  const full = (renderer.plugins.extract as PIXI.Extract).canvas(rt);
  rt.destroy(true);
  const probe = full.getContext('2d', { willReadFrequently: true });
  if (probe) {
    const d = probe.getImageData(0, 0, full.width, full.height).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4 * 16) { if (d[i] > 10) opaque += 1; }
    if (opaque < 20) return null;   // 空舞台：抓图作废，调用方保持占位下次再试
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#17171e';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(full, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}

/** 推进一帧模型时间并渲染消费（同 bakeIdle.advanceModelTime 的消费方式，不依赖 rAF）。 */
function advanceOnce(runtime: AnyRuntime, ms: number) {
  runtime.model.update(ms);
  const renderer = runtime.app.renderer as PIXI.Renderer;
  const rt = PIXI.RenderTexture.create({ width: 4, height: 4, resolution: 1 });
  renderer.render(runtime.app.stage, { renderTexture: rt });
  rt.destroy(true);
}

export function getCachedPortrait(avatarId: string): string | null {
  try { return localStorage.getItem(PORTRAIT_KEY(avatarId)); } catch { return null; }
}

function cachePortrait(avatarId: string, dataUrl: string) {
  try { localStorage.setItem(PORTRAIT_KEY(avatarId), dataUrl); } catch { /* 存储满：仅本次会话可用 */ }
}

/** 从面板已加载的 runtime 顺手抓头像（免二次加载大模型）。已缓存则直接返回缓存。 */
export function capturePortraitFromRuntime(runtime: AnyRuntime, avatarId: string): string | null {
  const cached = getCachedPortrait(avatarId);
  if (cached) return cached;
  const url = extractStage(runtime, PORTRAIT_SIZE);
  if (url) cachePortrait(avatarId, url);
  return url;
}

/** 屏外现渲一张角色头像（重操作，仅缓存未命中时用；内部建/毁独立 runtime）。 */
export async function generatePortrait(avatarId: string): Promise<string | null> {
  const cached = getCachedPortrait(avatarId);
  if (cached) return cached;
  const manifest = await resolveAvatarManifestById(avatarId);
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-9999px;top:0;width:${STAGE_SIZE}px;height:${STAGE_SIZE}px;pointer-events:none;`;
  document.body.appendChild(container);
  let runtime: AnyRuntime | null = null;
  try {
    runtime = await createLive2DRuntime(container, manifest);
    runtime.app.ticker.stop();   // 手动推几帧即可，不占 rAF
    (runtime as unknown as { idleBeatEnabled: boolean }).idleBeatEnabled = false;
    for (let i = 0; i < 4; i += 1) advanceOnce(runtime, 1000 / 60);
    const url = extractStage(runtime, PORTRAIT_SIZE);
    if (url) cachePortrait(avatarId, url);
    return url;
  } finally {
    if (runtime) { try { destroyRuntime(runtime); } catch { /* 上下文已丢失等 */ } }
    container.remove();
  }
}

/** wobble（安静呼吸）卡片的缩略图：当前自然姿态直出（先于动作缩略图抓，姿态未被污染）。 */
export function snapshotWobbleThumb(runtime: AnyRuntime): string | null {
  return extractStage(runtime, MOTION_THUMB_SIZE);
}

/** 批量抓「参数硬写」姿态缩略图（表情/配饰卡片用）：与动作缩略图同一注入位
 * （afterMotionUpdate，物理之前），每组 pins 推 3 帧后抓图。调用方先把表情折算成
 * 绝对参数（badgeCatalog.resolveExpressionPins），这里只管渲。 */
export function snapshotPinThumbs(
  runtime: AnyRuntime,
  pinSets: Array<{ id: string; pins: Array<[string, number]> }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const tickerWasRunning = runtime.app.ticker.started;
  if (tickerWasRunning) runtime.app.ticker.stop();
  try {
    for (const { id, pins } of pinSets) {
      const thumb = withHookedWrites(runtime, pins, MOTION_THUMB_SIZE);
      if (thumb) out[id] = thumb;
    }
  } finally {
    if (tickerWasRunning) runtime.app.ticker.start();
  }
  return out;
}

/** 批量抓动作中段姿态缩略图：先异步取齐动作文件（ticker 照常跑），再停 ticker 同步
 * 逐个「钩子写参→推一帧→抓图」，全程 <200ms，live 预览只闪一下不可察。 */
export async function snapshotMotionThumbs(
  runtime: AnyRuntime,
  options: Array<{ url: string }>,
): Promise<Record<string, string>> {
  const parsed: Array<{ url: string; motion: ReturnType<typeof parseMotion3> }> = [];
  for (const opt of options) {
    try {
      const res = await fetch(opt.url);
      if (!res.ok) continue;
      parsed.push({ url: opt.url, motion: parseMotion3(await res.json()) });
    } catch { /* 单个动作拉取失败：跳过，卡片用占位 */ }
  }
  const out: Record<string, string> = {};
  const tickerWasRunning = runtime.app.ticker.started;
  if (tickerWasRunning) runtime.app.ticker.stop();
  try {
    for (const { url, motion } of parsed) {
      const writes = evalMotionParams(motion, motion.duration * 0.5);
      const thumb = withHookedWrites(runtime, writes, MOTION_THUMB_SIZE);
      if (thumb) out[url] = thumb;
    }
  } finally {
    if (tickerWasRunning) runtime.app.ticker.start();
  }
  return out;
}
