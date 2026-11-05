/* .abp v1 打包器（浏览器版）——移植自固件仓 aiboo-badge/tools/abp-pack.cjs（含 lz4 codec，
 * Node 版为对拍基准，abpPack.test.ts 逐字节 md5 断言两版产物一致；格式规范 docs/abp-format.md）。
 *
 * 与 Node 版的差异只有输入形态：帧在内存里直接是 RGB565 Uint8Array（canvas 烘焙直出，
 * 跳过 PNG/fs），无 CLI/统计/预算检查（预算判断由调用方 UI 做）。
 * 字节级契约（勿动）：manifest JSON 的键序按 Node 版构造顺序；段偏移相对 data_base，
 * 段起始 4 字节对齐；delta 帧=u16 变化块数 + N×[u16 块索引升序, 块像素]；delta ≥ 全帧时
 * 回退 key 帧；参考帧=重建参考帧（解码端实际显示的帧，容差误差不随帧数累积）。
 */

import { lz4Compress } from './lz4Block.ts';

const MAGIC = 'ABP1';
const PACK_VERSION = 1;
const BLOCK = 16;

const align4 = (n: number) => (n + 3) & ~3;

export type AbpRegion = { x: number; y: number; w: number; h: number };

export type AbpAssets = {
  characterId: string;
  screen: { w: number; h: number };
  states: Array<{ name: string; data: Uint8Array }>;
  eyes: { region: AbpRegion; frames: Uint8Array[] } | null;
  mouth: { region: AbpRegion; frames: Uint8Array[] } | null;
  motions: Array<{
    name: string;
    fps: number;
    loop: boolean;
    trigger: string | null;
    frames: Uint8Array[];
    mouth_anchors?: Array<[number, number]>;
    /** 循环起拍点（速度谷），固件起播用；帧 0 恒为基线（位级不变量） */
    start_idx?: number;
  }>;
};

type Grid = { size: number; cols: number; rows: number };
type Rect = { x: number; y: number; w: number; h: number };

function gridFor(w: number, h: number): Grid {
  return { size: BLOCK, cols: Math.ceil(w / BLOCK), rows: Math.ceil(h / BLOCK) };
}

function blockRect(grid: Grid, screenW: number, screenH: number, idx: number): Rect {
  const col = idx % grid.cols;
  const row = (idx / grid.cols) | 0;
  const x = col * grid.size;
  const y = row * grid.size;
  return { x, y, w: Math.min(grid.size, screenW - x), h: Math.min(grid.size, screenH - y) };
}

function readU16(a: Uint8Array, off: number): number {
  return a[off] | (a[off + 1] << 8);
}

function rgb565Expand(v: number): [number, number, number] {
  return [(v >> 11) << 3, ((v >> 5) & 0x3f) << 2, (v & 0x1f) << 3];
}

function blockWithinTolerance(a: Uint8Array, b: Uint8Array, screenW: number, r: Rect, tol: number): boolean {
  for (let ry = 0; ry < r.h; ry += 1) {
    const rowOff = ((r.y + ry) * screenW + r.x) * 2;
    for (let rx = 0; rx < r.w; rx += 1) {
      const off = rowOff + rx * 2;
      const va = readU16(a, off);
      const vb = readU16(b, off);
      if (va === vb) continue;
      if (tol <= 0) return false;
      const [ar, ag, ab2] = rgb565Expand(va);
      const [br, bg, bb] = rgb565Expand(vb);
      if (Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab2 - bb)) > tol) return false;
    }
  }
  return true;
}

function encodeDeltaFrame(ref: Uint8Array, cur: Uint8Array, screenW: number, screenH: number, tol: number) {
  const grid = gridFor(screenW, screenH);
  const total = grid.cols * grid.rows;
  const changed: Array<{ idx: number; r: Rect }> = [];
  let bytes = 2;
  for (let idx = 0; idx < total; idx += 1) {
    const r = blockRect(grid, screenW, screenH, idx);
    if (!blockWithinTolerance(ref, cur, screenW, r, tol)) {
      changed.push({ idx, r });
      bytes += 2 + r.w * r.h * 2;
    }
  }
  const buf = new Uint8Array(bytes);
  buf[0] = changed.length & 0xff;
  buf[1] = (changed.length >> 8) & 0xff;
  let o = 2;
  for (const { idx, r } of changed) {
    buf[o] = idx & 0xff;
    buf[o + 1] = (idx >> 8) & 0xff;
    o += 2;
    for (let ry = 0; ry < r.h; ry += 1) {
      const src = ((r.y + ry) * screenW + r.x) * 2;
      buf.set(cur.subarray(src, src + r.w * 2), o);
      o += r.w * 2;
    }
  }
  return { buf, blocks: changed.length, changedRects: changed.map((c) => c.r) };
}

function patchRefBlocks(ref: Uint8Array, cur: Uint8Array, screenW: number, rects: Rect[]) {
  for (const r of rects) {
    for (let ry = 0; ry < r.h; ry += 1) {
      const off = ((r.y + ry) * screenW + r.x) * 2;
      ref.set(cur.subarray(off, off + r.w * 2), off);
    }
  }
}

export type AbpPackResult = {
  buffer: Uint8Array;
  manifest: Record<string, unknown>;
  dataBase: number;
};

export function packAssets(assets: AbpAssets, deltaTol = 0, codec: 'lz4' | null = null): AbpPackResult {
  const { screen } = assets;
  const fullSize = screen.w * screen.h * 2;
  for (const s of assets.states) {
    if (s.data.length !== fullSize) throw new Error(`states/${s.name}: 尺寸 ${s.data.length} ≠ 全屏 ${fullSize}`);
  }
  for (const m of assets.motions) {
    if (!m.frames.length) throw new Error(`motions/${m.name}: 无帧`);
    for (const f of m.frames) {
      if (f.length !== fullSize) throw new Error(`motions/${m.name}: 帧尺寸 ${f.length} ≠ 全屏 ${fullSize}`);
    }
  }

  const segments: Array<{ offset: number; data: Uint8Array }> = [];
  let cursor = 0;
  const addSeg = (data: Uint8Array) => {
    const ref = { offset: cursor, size: data.length };
    segments.push({ offset: cursor, data });
    cursor = align4(cursor + data.length);
    return ref;
  };

  // 键序=Node 版构造顺序（JSON.stringify 按插入序），对拍字节一致的前提
  const manifest: Record<string, unknown> = {
    pack_version: PACK_VERSION,
    character_id: assets.characterId,
    screen: { w: screen.w, h: screen.h, format: 'rgb565le' },
    block: gridFor(screen.w, screen.h),
    states: assets.states.map((s) => ({ name: s.name, ...addSeg(s.data) })),
    eyes: null,
    mouth: null,
    motions: [],
  };
  if (assets.eyes) {
    manifest.eyes = { region: assets.eyes.region, frames: assets.eyes.frames.map((f) => addSeg(f)) };
  }
  if (assets.mouth) {
    manifest.mouth = { region: assets.mouth.region, levels: assets.mouth.frames.map((f) => addSeg(f)) };
  }

  const motionEntries: Array<Record<string, unknown>> = [];
  for (const m of assets.motions) {
    const frames: Array<Record<string, unknown>> = [];
    frames.push({ type: 'key', ...addSeg(m.frames[0]) });
    const ref = new Uint8Array(m.frames[0]);   // 重建参考帧
    let maxRawDelta = 0;
    for (let i = 1; i < m.frames.length; i += 1) {
      const { buf, blocks, changedRects } = encodeDeltaFrame(ref, m.frames[i], screen.w, screen.h, deltaTol);
      if (buf.length >= fullSize) {
        frames.push({ type: 'key', ...addSeg(m.frames[i]) });
        ref.set(m.frames[i]);
      } else if (codec === 'lz4') {
        // codec 战役(2026-07-04)：delta 载荷 LZ4 block 压缩（动漫像素实测 ~1.76x）。
        // key 帧保持原始（回卷整帧 memcpy 不加解压延迟）；压不动（罕见）则回退原始。
        const c = lz4Compress(buf);
        if (c.length < buf.length) {
          frames.push({ type: 'delta', ...addSeg(c), blocks, codec: 'lz4', raw_size: buf.length });
          if (buf.length > maxRawDelta) maxRawDelta = buf.length;
        } else {
          frames.push({ type: 'delta', ...addSeg(buf), blocks });
        }
        patchRefBlocks(ref, m.frames[i], screen.w, changedRects);
      } else {
        frames.push({ type: 'delta', ...addSeg(buf), blocks });
        patchRefBlocks(ref, m.frames[i], screen.w, changedRects);
      }
    }
    motionEntries.push({
      name: m.name,
      fps: m.fps,
      frame_count: m.frames.length,
      loop: m.loop,
      trigger: m.trigger,
      frames,
      mouth_anchors: m.mouth_anchors || undefined,
      // 缺省不写（等价 0）；固件 clamp 到 [0,ram_frames-1]
      start_idx: m.start_idx != null ? m.start_idx : undefined,
      // 解压 scratch 尺寸（固件按全 motion 最大 raw delta 分配一块复用）
      max_raw_delta: maxRawDelta || undefined,
    });
  }
  manifest.motions = motionEntries;

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const dataBase = align4(8 + manifestBytes.length);
  const out = new Uint8Array(dataBase + cursor);   // 零填充即段间 padding
  out[0] = MAGIC.charCodeAt(0); out[1] = MAGIC.charCodeAt(1);
  out[2] = MAGIC.charCodeAt(2); out[3] = MAGIC.charCodeAt(3);
  out[4] = manifestBytes.length & 0xff;
  out[5] = (manifestBytes.length >> 8) & 0xff;
  out[6] = (manifestBytes.length >> 16) & 0xff;
  out[7] = (manifestBytes.length >> 24) & 0xff;
  out.set(manifestBytes, 8);
  for (const seg of segments) out.set(seg.data, dataBase + seg.offset);
  return { buffer: out, manifest, dataBase };
}

/** canvas → 黑底合成 RGB565LE（与 abp 位图段约定一致；exportUtils.canvasToRgb565 的等价物，
 * 这里收编进库避免 features→tools 的反向依赖）。 */
export function canvasToRgb565Black(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法读取画布');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height * 2);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 2) {
    const a = data[i + 3] / 255;
    const r = Math.round(data[i] * a);
    const g = Math.round(data[i + 1] * a);
    const b = Math.round(data[i + 2] * a);
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
  }
  return out;
}

// —— 出货口径帮手（单一真相源：面板与预算编排共用，勿在 UI 层复刻公式）——

import type { BakeResult } from './bakeIdle.ts';

/** 固件预载大小（KB）：Σ motions 帧尺寸 + max_raw_delta（解压 scratch）。
 * 与固件 PSRAM 预载口径一致（3417KB 是板上实测墙，常量在 bakeBudget）。 */
export function preloadKbOf(manifest: Record<string, unknown> | unknown): number {
  const motions = (manifest as { motions?: Array<{ frames?: Array<{ size?: number }>; max_raw_delta?: number }> })?.motions ?? [];
  const frameBytes = motions.reduce((a, m) => a + (m.frames ?? []).reduce((x, f) => x + (f.size ?? 0), 0), 0);
  return Math.round((frameBytes + (motions[0]?.max_raw_delta ?? 0)) / 1024);
}

/** 烘焙结果 → 吧唧 .abp（delta-tol 2 吞 AA 微抖 + lz4，固件 codec 战役已烧验）。
 * 帧 0=基线（天然对齐），口型套件随附；投放与预算实测用同一份产物。 */
export function packBakedBadge(baked: BakeResult, characterId: string): AbpPackResult {
  const rgb565 = baked.frames.map((f) => canvasToRgb565Black(f));
  return packAssets({
    characterId,
    screen: { w: baked.frames[0].width, h: baked.frames[0].height },
    states: [{ name: 'neutral', data: rgb565[0] }],
    eyes: null,
    mouth: baked.mouth
      ? { region: baked.mouth.region, frames: baked.mouth.levels.map((c) => canvasToRgb565Black(c)) }
      : null,
    motions: [{
      name: 'idle', fps: baked.fps, loop: true, trigger: 'idle',
      frames: rgb565, start_idx: baked.startIdx,
      mouth_anchors: baked.mouth?.anchors,
    }],
  }, 2, 'lz4');
}
