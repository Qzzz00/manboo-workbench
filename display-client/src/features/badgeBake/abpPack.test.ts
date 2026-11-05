/* abpPack 对拍单测：同一份帧集，浏览器版 packAssets vs Node 版 abp-pack.cjs（固件仓
 * aiboo-badge=现役基准，含 lz4 codec）产物逐字节一致（md5）。
 * 覆盖：容器布局/manifest 键序/delta 编码/key 回退/lz4+start_idx/4 对齐。 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packAssets, type AbpAssets } from './abpPack.ts';

const NODE_PACK = join(process.env.HOME ?? '', 'Documents/GitHub/aiboo-badge/tools/abp-pack.cjs');   // 固件仓=现役基准（含 lz4 codec）

const W = 34, H = 34;   // 非 16 整除：覆盖边缘块（右/下 2px 块）
const FULL = W * H * 2;

/** 决定性伪随机帧（无 Math.random——种子线性同余） */
function frame(seed: number): Uint8Array {
  const out = new Uint8Array(FULL);
  let s = seed >>> 0;
  for (let i = 0; i < FULL; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}
/** 在 base 上改动少数块（delta 路径） */
function tweak(base: Uint8Array, px: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(base);
  for (const [x, y] of px) {
    const off = (y * W + x) * 2;
    out[off] = out[off] ^ 0xff;
  }
  return out;
}

const f0 = frame(1);
const f1 = tweak(f0, [[0, 0], [20, 20]]);      // 少量块变化 → delta
const f2 = frame(2);                            // 整帧全变 → key 回退
const f3 = tweak(f2, [[33, 33]]);               // 右下角 2×2 边缘块

const assets: AbpAssets = {
  characterId: 'testchar',
  screen: { w: W, h: H },
  states: [{ name: 'neutral', data: f0 }],
  eyes: null,
  mouth: null,
  motions: [{ name: 'idle', fps: 10, loop: true, trigger: 'idle', frames: [f0, f1, f2, f3] }],
};

function nodePack(extraArgs: string[], startIdx?: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'abp-fixture-'));
  try {
    writeFileSync(join(dir, 'character.json'), JSON.stringify({ character_id: 'testchar', screen: { w: W, h: H } }));
    mkdirSync(join(dir, 'states'));
    writeFileSync(join(dir, 'states', 'neutral.bin'), f0);
    mkdirSync(join(dir, 'motions/idle'), { recursive: true });
    writeFileSync(join(dir, 'motions/idle/meta.json'), JSON.stringify({
      fps: 10, loop: true, trigger: 'idle', ...(startIdx !== undefined ? { start_idx: startIdx } : {}),
    }));
    [f0, f1, f2, f3].forEach((f, i) => writeFileSync(join(dir, `motions/idle/frame_${i}.bin`), f));
    const outPath = join(dir, 'out.abp');
    execFileSync('node', [NODE_PACK, dir, '-o', outPath, '--quiet', ...extraArgs]);
    return readFileSync(outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

describe('packAssets 对拍 Node abp-pack.cjs', () => {
  it.skipIf(!existsSync(NODE_PACK))('raw 产物逐字节一致', () => {
    const nodeBytes = nodePack([]);
    const mine = packAssets(assets).buffer;
    expect(mine.length).toBe(nodeBytes.length);
    expect(md5(mine)).toBe(md5(nodeBytes));
  });

  it.skipIf(!existsSync(NODE_PACK))('lz4 codec + start_idx 产物逐字节一致', () => {
    const nodeBytes = nodePack(['--codec', 'lz4'], 2);
    const withStart = { ...assets, motions: [{ ...assets.motions[0], start_idx: 2 }] };
    const mine = packAssets(withStart, 0, 'lz4').buffer;
    expect(mine.length).toBe(nodeBytes.length);
    expect(md5(mine)).toBe(md5(nodeBytes));
  });

  it('容器头与段对齐自洽（无 Node 版也可跑的兜底断言）', () => {
    const { buffer, dataBase } = packAssets(assets);
    expect(String.fromCharCode(...buffer.subarray(0, 4))).toBe('ABP1');
    const mlen = buffer[4] | (buffer[5] << 8) | (buffer[6] << 16) | (buffer[7] << 24);
    const manifest = JSON.parse(new TextDecoder().decode(buffer.subarray(8, 8 + mlen)));
    expect(dataBase % 4).toBe(0);
    expect(manifest.block).toEqual({ size: 16, cols: 3, rows: 3 });
    const frames = manifest.motions[0].frames;
    expect(frames[0].type).toBe('key');
    expect(frames[1].type).toBe('delta');
    expect(frames[2].type).toBe('key');       // 整帧变化 → key 回退
    expect(frames[3].type).toBe('delta');
    // delta 段：u16 块数 + 升序块索引
    const d1 = buffer.subarray(dataBase + frames[1].offset, dataBase + frames[1].offset + frames[1].size);
    const nBlocks = d1[0] | (d1[1] << 8);
    expect(nBlocks).toBe(frames[1].blocks);
    expect(nBlocks).toBe(2);                  // 两个像素点各落一块
  });

  it('尺寸不符 fail-fast', () => {
    expect(() => packAssets({ ...assets, states: [{ name: 'bad', data: new Uint8Array(10) }] }))
      .toThrow(/尺寸/);
  });
});

describe('preloadKbOf（固件预载口径：Σ motions 帧尺寸 + max_raw_delta）', () => {
  it('手工 manifest 对拍', async () => {
    const { preloadKbOf } = await import('./abpPack.ts');
    const manifest = {
      motions: [
        { frames: [{ size: 1024 }, { size: 2048 }], max_raw_delta: 1024 },
        { frames: [{ size: 4096 }] },
      ],
    };
    // (1024+2048+4096+1024)/1024 = 8KB
    expect(preloadKbOf(manifest)).toBe(8);
  });
  it('空 motions 返回 0', async () => {
    const { preloadKbOf } = await import('./abpPack.ts');
    expect(preloadKbOf({ motions: [] })).toBe(0);
  });
});
