/* 纯 JS LZ4 block 编/解码器——移植自固件仓 tools/lz4-block.cjs（codec 战役 2026-07-04），
 * Buffer→Uint8Array 机械翻译，算法逐行对齐（abpPack.test.ts 对拍保证压缩字节流一致）。
 * 固件端解码 badge_face/lz4_dec.c（~80 行 block 解码），两端都用最朴素 block 格式。
 * 压缩器=贪心+4字节哈希链；安全规则：最后 5 字节必须字面，匹配不得延伸进最后 5 字节。 */

const MIN_MATCH = 4;
const HASH_LOG = 16;
const HASH_SIZE = 1 << HASH_LOG;

function hash32(v: number): number {
  return ((v * 2654435761) >>> (32 - HASH_LOG)) & (HASH_SIZE - 1);
}

export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 64);
  const table = new Int32Array(HASH_SIZE).fill(-1);
  let ip = 0;
  let op = 0;
  let anchor = 0;
  const mflimit = n - MIN_MATCH - 5;

  const read32 = (p: number) => src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24);

  const emit = (litLen: number, matchLen: number, matchOff: number) => {
    const mlToken = matchLen < 0 ? 0 : Math.min(matchLen - MIN_MATCH, 15);
    const token = (Math.min(litLen, 15) << 4) | mlToken;
    out[op++] = token;
    if (litLen >= 15) { let r = litLen - 15; while (r >= 255) { out[op++] = 255; r -= 255; } out[op++] = r; }
    out.set(src.subarray(anchor, anchor + litLen), op);
    op += litLen;
    if (matchLen < 0) return;
    out[op++] = matchOff & 0xff;
    out[op++] = (matchOff >> 8) & 0xff;
    if (matchLen - MIN_MATCH >= 15) { let r = matchLen - MIN_MATCH - 15; while (r >= 255) { out[op++] = 255; r -= 255; } out[op++] = r; }
  };

  while (ip <= mflimit) {
    const h = hash32(read32(ip));
    const ref = table[h];
    table[h] = ip;
    if (ref >= 0 && ip - ref <= 0xffff && read32(ref) === read32(ip)) {
      // 向后扩展：把匹配头部吃进已积累的字面区（字面变匹配=白赚）
      let back = 0;
      while (ip - back > anchor && ref - back > 0 && src[ref - back - 1] === src[ip - back - 1]) back += 1;
      const mStart = ip - back;
      const rStart = ref - back;
      let ml = MIN_MATCH + back;
      const maxMl = n - 5 - mStart;
      while (ml < maxMl && src[rStart + ml] === src[mStart + ml]) ml += 1;
      emit(mStart - anchor, ml, mStart - rStart);
      // 匹配区内隔 2 播种哈希——对周期性像素数据增益显著
      const end = mStart + ml;
      for (let p = ip + 1; p + MIN_MATCH <= end && p <= mflimit; p += 2) table[hash32(read32(p))] = p;
      ip = end;
      anchor = ip;
    } else {
      ip += 1;
    }
  }
  emit(n - anchor, -1, 0);   // 末序列：剩余全部字面
  return out.slice(0, op);
}

export function lz4Decompress(src: Uint8Array, rawSize: number): Uint8Array {
  const out = new Uint8Array(rawSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let litLen = token >> 4;
    if (litLen === 15) { let b; do { b = src[ip++]; litLen += b; } while (b === 255); }
    out.set(src.subarray(ip, ip + litLen), op);
    ip += litLen;
    op += litLen;
    if (ip >= src.length) break;
    const off = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    let ml = (token & 15) + MIN_MATCH;
    if ((token & 15) === 15) { let b; do { b = src[ip++]; ml += b; } while (b === 255); }
    let mp = op - off;
    for (let i = 0; i < ml; i += 1) out[op++] = out[mp++];   // 逐字节（允许重叠拷贝）
  }
  if (op !== rawSize) throw new Error(`lz4 decompress 长度不符: ${op} vs ${rawSize}`);
  return out;
}
