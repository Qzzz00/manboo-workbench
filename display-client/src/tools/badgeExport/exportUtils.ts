// 电子吧唧素材导出：纯工具函数（RGB565 转换 / 文件下载 / manifest 记录类型）。
// 硬件：ESP32 + 466×466 圆形屏，帧格式 RGB565（R5 G6 B5，小端），每像素 2 字节。

export type ExportRegion = { x: number; y: number; w: number; h: number };

export type BadgeExportRecord = {
  avatarId: string;
  /**
   * 素材用途：state=状态立绘（label 细分待机/聆听/思考/说话）、blink=眨眼序列、mouth=口型帧、
   * idle_motion=待机动作连拍、speak_motion=说话动作连拍（嘴锚点）、listen_expr=聆听表情局部贴图、
   * error_state=错误状态帧
   */
  kind: 'state' | 'blink' | 'mouth' | 'idle_motion' | 'speak_motion' | 'listen_expr' | 'error_state';
  /** kind=state 时的细分状态名（idle/listen/think/talk） */
  label?: string;
  /** 裁剪区（屏幕坐标，左上原点）；全屏导出为 'full' */
  region: ExportRegion | 'full';
  /** 本组导出的文件名（含扩展名，按导出顺序） */
  frames: string[];
  /** 单帧像素尺寸（bin 大小 = w*h*2 字节） */
  size: { w: number; h: number };
  formats: string[];
  /** 序列驱动的参数（id + 每帧数值），如眨眼的眼参数/口型的嘴参数 */
  params?: { ids: string[]; values: number[] };
  /** kind=idle_motion 时的抓帧帧率 */
  fps?: number;
  /** 合成到最底层的背景图（badge-assets 相对路径）；无背景为 undefined（透明底） */
  background?: string;
  /** 循环序列的环形相邻帧 MAD（诊断用，[0] 为回卷对）：量化该动作在此 fps 下的观感风险 */
  frameMads?: number[];
  /**
   * 循环序列的起拍下标（速度谷，见 findLoopValleyIndex）：帧序落盘时保持抓拍自然序不变
   * （帧 0 = 基线，固件位级不变量），该下标供固件起播时使用。省略等价 0。
   */
  startIdx?: number;
  createdAt: string;
};

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** canvas → PNG Blob（toBlob 回调转 Promise）。 */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 返回空'))), 'image/png');
  });
}

/**
 * canvas → RGB565 小端字节流。硬件帧缓冲无 alpha 通道，先把画面合成到底色
 * （默认纯黑，对应圆形屏点不亮的区域），再逐像素打包 R5G6B5：低字节在前（小端）。
 * 输出恒为 width*height*2 字节。
 */
export function canvasToRgb565(source: HTMLCanvasElement, background = '#000000'): Uint8Array {
  const { width, height } = source;
  const composite = document.createElement('canvas');
  composite.width = width;
  composite.height = height;
  const ctx = composite.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2d 上下文');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0);

  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height * 2);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 2) {
    const value = ((data[i] >> 3) << 11) | ((data[i + 1] >> 2) << 5) | (data[i + 2] >> 3);
    out[p] = value & 0xff; // 低字节在前
    out[p + 1] = (value >> 8) & 0xff;
  }
  return out;
}

/** 统计不透明像素数（alpha>0），用于判断抓到的帧是否空白。 */
export function countOpaquePixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) count += 1;
  }
  return count;
}

/** Blob → base64（分块 btoa，避免大文件展开成超长参数列表）。 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 落盘到 dev server 的仓库根 badge-assets/ 目录（vite.config.ts 的 /__badge_export 中间件，仅 dev 生效）。
 * 失败抛错，调用方可回退浏览器下载。
 */
export async function saveToBadgeAssets(relPath: string, blob: Blob): Promise<void> {
  const base64 = await blobToBase64(blob);
  const response = await fetch('/__badge_export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: relPath, base64 }),
  });
  if (!response.ok) {
    throw new Error(`badge-assets 落盘失败（HTTP ${response.status}）`);
  }
}

function getImageDataOf(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2d 上下文');
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** 两张同尺寸画布的差异像素数（RGBA 绝对差之和 > threshold 记 1 个），自检序列帧是否真在变化。 */
export function diffPixelCount(a: HTMLCanvasElement, b: HTMLCanvasElement, threshold = 8): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  const da = getImageDataOf(a);
  const db = getImageDataOf(b);
  let count = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1])
      + Math.abs(da[i + 2] - db[i + 2]) + Math.abs(da[i + 3] - db[i + 3]);
    if (d > threshold) count += 1;
  }
  return count;
}

/**
 * 两张同尺寸画布的像素差异包围盒（如嘴 0 vs 嘴 1 自动求嘴部区域）。
 * 抗噪设计：相邻两次渲染存在少量微动噪声（物理/视线每次 update 微推进，实测同参数
 * 两帧也有约几百个低幅差异像素，且散布全身）——因此：
 *  ① 阈值取较高（默认 RGBA 绝对差之和 > 48）过滤低幅噪声；
 *  ② 行/列投影密度过滤：仅统计「该行(列)差异像素数 ≥ minLine」的行列，散点噪声不成行成列。
 * 求出核心区后外扩 pad 像素、x/y 向下取偶、宽高向上取偶（硬件贴图常要求偶对齐）、夹到画布内。
 * 无有效差异返回 null。
 */
export function diffBoundingBox(
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  pad = 8,
  threshold = 48,
  minLine = 3,
): ExportRegion | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const width = a.width;
  const height = a.height;
  const da = getImageDataOf(a);
  const db = getImageDataOf(b);
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1])
        + Math.abs(da[i + 2] - db[i + 2]) + Math.abs(da[i + 3] - db[i + 3]);
      if (d > threshold) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }
  let minX = -1;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowCounts[y] >= minLine) {
      if (minY < 0) minY = y;
      maxY = y;
    }
  }
  for (let x = 0; x < width; x += 1) {
    if (colCounts[x] >= minLine) {
      if (minX < 0) minX = x;
      maxX = x;
    }
  }
  if (minX < 0 || minY < 0) return null;

  let x0 = Math.max(0, minX - pad);
  let y0 = Math.max(0, minY - pad);
  x0 -= x0 % 2;
  y0 -= y0 % 2;
  let x1 = Math.min(width, maxX + 1 + pad);
  let y1 = Math.min(height, maxY + 1 + pad);
  if ((x1 - x0) % 2) x1 = Math.min(width, x1 + 1);
  if ((y1 - y0) % 2) y1 = Math.min(height, y1 + 1);
  // 边界收不进偶数时向内收一像素（保证偶宽高）
  if ((x1 - x0) % 2) x1 -= 1;
  if ((y1 - y0) % 2) y1 -= 1;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 把（可能带透明的）角色帧合成到背景图之上，输出不透明成品帧。
 * region：帧对应的视口裁剪区——背景按同一区域裁剪对位（背景尺寸须与整屏视口一致）。
 */
export function compositeOnBackground(
  frame: HTMLCanvasElement,
  background: CanvasImageSource,
  region: ExportRegion | null,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = frame.width;
  out.height = frame.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建 2d 上下文');
  if (region) {
    ctx.drawImage(background, region.x, region.y, region.w, region.h, 0, 0, frame.width, frame.height);
  } else {
    ctx.drawImage(background, 0, 0, frame.width, frame.height);
  }
  ctx.drawImage(frame, 0, 0);
  return out;
}

/** 两个区域的交集（无交集返回 null）。偶对齐区域求交仍保持偶对齐。 */
export function intersectRegions(a: ExportRegion | null, b: ExportRegion | null): ExportRegion | null {
  if (!a || !b) return a ?? b;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 触发浏览器下载（多文件连续下载时调用方自行 sleep 间隔，避免被拦截）。 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟释放：立刻 revoke 在部分浏览器会取消进行中的下载。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type AnchorMatch = { dx: number; dy: number; residual: number };

/**
 * 在 frame 的 region 邻域(±radius 像素)内模板匹配 baseline 的 region 贴图。
 * 返回最佳平移 (dx,dy) 与平均残差（每采样通道 0-255）。RGBA 输入，隔行隔列采样。
 * contextPad（孔径问题修复）：嘴 region 大部分是光滑皮肤时，小窗口 SAD 在大半径里全是
 * 假极小值（贴到脸颊/下巴皮肤上）。>0 时匹配窗口每边外扩 contextPad 像素（涵盖下巴/鼻底/
 * 唇角等结构），用大窗口**选偏移**；偏移是纯平移，直接适用于原 region。外扩窗口夹回画布。
 * 残差恒在**原 region** 上计量（选中偏移处重算）：动作使下巴/头发在上下文窗口里形变属于
 * 正常现象，不应虚增「嘴区残差」——容差语义始终是嘴区本身的匹配质量。
 */
export function findMouthAnchor(
  baseline: Uint8ClampedArray,
  frame: Uint8ClampedArray,
  width: number,
  region: ExportRegion,
  radius: number,
  contextPad = 0,
): AnchorMatch {
  const height = frame.length / 4 / width;
  const wx0 = Math.max(0, region.x - contextPad);
  const wy0 = Math.max(0, region.y - contextPad);
  const wx1 = Math.min(width, region.x + region.w + contextPad);
  const wy1 = Math.min(height, region.y + region.h + contextPad);
  const win: ExportRegion = { x: wx0, y: wy0, w: wx1 - wx0, h: wy1 - wy0 };

  const sadAt = (r: ExportRegion, dx: number, dy: number): number | null => {
    if (r.x + dx < 0 || r.y + dy < 0 || r.x + r.w + dx > width || r.y + r.h + dy > height) return null;
    let sad = 0;
    let n = 0;
    for (let y = 0; y < r.h; y += 2) {
      for (let x = 0; x < r.w; x += 2) {
        const b = ((r.y + y) * width + r.x + x) * 4;
        const f = ((r.y + y + dy) * width + r.x + x + dx) * 4;
        sad += Math.abs(baseline[b] - frame[f])
          + Math.abs(baseline[b + 1] - frame[f + 1])
          + Math.abs(baseline[b + 2] - frame[f + 2]);
        n += 3;
      }
    }
    return sad / n;
  };

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const score = sadAt(win, dx, dy);
      if (score !== null && score < bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // 残差在原 region 上重算（region ⊆ win，win 通过越界检查则 region 也不越界）
  const residual = sadAt(region, bestDx, bestDy);
  return { dx: bestDx, dy: bestDy, residual: residual ?? bestScore };
}

/**
 * 环形序列的相邻帧 MAD（RGBA 通道平均绝对差）：mads[i] = MAD(frame[(i-1+n)%n], frame[i])。
 * mads[0] 即回卷对（末帧→帧 0）。用于导出诊断（frame_mads）与「速度谷」起拍点选择。
 * 少于 2 帧返回空数组。
 */
export function adjacentLoopMads(frames: Uint8ClampedArray[]): number[] {
  const n = frames.length;
  if (n < 2) return [];
  const mads: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = frames[(i - 1 + n) % n];
    const b = frames[i];
    let sum = 0;
    for (let p = 0; p < a.length; p += 1) sum += Math.abs(a[p] - b[p]);
    mads.push(sum / a.length);
  }
  return mads;
}

/**
 * 循环序列的「速度谷」起拍下标：环形相邻 MAD（见 adjacentLoopMads）最小处的下标，
 * 即最柔和的转移处。平局取第一个最小下标（含少于 2 帧时的退化情形，统一返回 0）。
 * 只选下标，不对帧序列做任何重排——帧 0 必须保持抓拍自然序不变（固件位级不变量），
 * 该下标随 meta.json 的 start_idx 落盘，由固件起播时使用。
 */
export function findLoopValleyIndex(frames: Uint8ClampedArray[]): number {
  const mads = adjacentLoopMads(frames);
  if (mads.length === 0) return 0;
  return mads.indexOf(Math.min(...mads));
}

/** 数组从 start 下标环形旋转（start 越界自动取模）。返回新数组。 */
export function rotateArray<T>(arr: T[], start: number): T[] {
  const n = arr.length;
  if (n === 0) return [];
  const s = ((start % n) + n) % n;
  return [...arr.slice(s), ...arr.slice(0, s)];
}

/**
 * 循环闭合（首尾交叉淡化）：末 K 帧向帧 0 做线性混合，消除正向循环回卷到帧 0 时的位形跳变
 * （如发丝物理不闭环）。第 i 个被处理帧（原序列下标 N-K+i，i=0..K-1）按 w=(i+1)/(K+1)
 * 混合：out = frame*(1-w) + frame0*w——越接近末尾权重越大，越贴近帧 0。
 * 帧 0 与前 N-K 帧不变。K ≥ 帧数时视为退化（不处理，避免把整段序列都拉向帧 0）。
 * 必须在合成背景之前的原始 RGBA 上做（否则背景被重复混合）；返回新数组，不修改输入。
 */
export function blendFrames(frames: Uint8ClampedArray[], k: number): Uint8ClampedArray[] {
  const n = frames.length;
  if (k <= 0 || k >= n) return frames.slice();
  const frame0 = frames[0];
  const out = frames.slice();
  for (let i = 0; i < k; i += 1) {
    const idx = n - k + i;
    const w = (i + 1) / (k + 1);
    const src = frames[idx];
    const blended = new Uint8ClampedArray(src.length);
    for (let p = 0; p < src.length; p += 1) {
      blended[p] = src[p] * (1 - w) + frame0[p] * w;
    }
    out[idx] = blended;
  }
  return out;
}

/** 两张同尺寸 RGBA 图的差异包围盒（任一通道差 > threshold 记为差异），外扩 pad 并夹回画布。全同返回 null。 */
export function computeDiffRegion(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  pad: number,
): ExportRegion | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (Math.abs(a[o] - b[o]) > threshold
        || Math.abs(a[o + 1] - b[o + 1]) > threshold
        || Math.abs(a[o + 2] - b[o + 2]) > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
