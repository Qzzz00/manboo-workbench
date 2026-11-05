/**
 * VAD 阈值：默认值 + URL 参数覆盖。真机现场调灵敏度不用重打包——
 * 直接改 holo.html?vad=0.05&silence=1000 之类。纯函数，可测；useHoloVoice 消费。
 */

export interface VadConfig {
  /** 高于此 RMS(0..1) 判「有人说话」——主灵敏度旋钮，太吵调高、迟钝调低。 */
  startRms: number;
  /** 低于此 RMS 计入静音（迟滞，须 < startRms）。 */
  stopRms: number;
  /** 连续几帧过阈才算真开始（滤瞬时噪点）。 */
  startFrames: number;
  /** 说话中静音这么久(ms) → 一句话结束。 */
  silenceMs: number;
  /** 太短的段(ms)丢弃（咳嗽/点击）。 */
  minUtterMs: number;
  /** 单句上限(ms)，防跑飞。 */
  maxUtterMs: number;
}

export const VAD_DEFAULTS: VadConfig = {
  // ★0.035→0.055 / 3→5 帧：Ben 实测「不说话有点动静就叫」。
  // 电台是【喇叭和麦克风同体】的小机器，环境噪声和自己放的音乐都会灌进麦，
  // 门槛太低+起始帧太少 → 随便一点动静就被当成有人说话开了一段。
  // 提高门槛要求「更清楚、更持续」的人声才起段（5 帧 ≈ 80ms 持续能量，滤掉敲击/咔哒这类瞬态）。
  // ⚠️调过头的代价是「说话没反应」，比误叫更烦——所以只提到 0.055 而不是更高，
  // 现场可用 ?vad=0.04（更灵敏）/ ?vad=0.08（更迟钝）试，不用重打包。
  startRms: 0.055,
  stopRms: 0.02,
  startFrames: 5,
  // ★800→450：这是「说完话到有反应」里最大的一段**纯死等**——说完后要先听满这么久的静音
  // 才算断句，之后才发 ASR。U3 电台的指令大多是「下一首」「暂停」这种短句，450ms 足够断干净，
  // 又省下 350ms。（若发现长句被从中间切断，往回调到 600-700ms；现场可用 ?silence=600 试，
  // 不用重打包。）
  silenceMs: 450,
  // 350→450：一句真指令（「下一首」）至少半秒；再短的多半是碰撞声/单个音符，
  // 滤掉它们能少一批误叫（这条同时也是 onstop 里丢弃段的门槛）。
  minUtterMs: 450,
  maxUtterMs: 12000,
};

// 每个旋钮：URL 参数名 + 合法区间(闭)。越界/非数值 → 回落该字段默认值。
const KNOBS: Record<keyof VadConfig, { param: string; min: number; max: number; int?: boolean }> = {
  startRms: { param: 'vad', min: 0.001, max: 1 },
  stopRms: { param: 'vadstop', min: 0.001, max: 1 },
  startFrames: { param: 'frames', min: 1, max: 30, int: true },
  silenceMs: { param: 'silence', min: 100, max: 10000 },
  minUtterMs: { param: 'minutter', min: 50, max: 5000 },
  maxUtterMs: { param: 'maxutter', min: 1000, max: 60000 },
};

/** 从 location.search（含或不含前导 '?'）解析 VAD 配置，未给/非法的字段回落默认。 */
export function resolveVadConfig(search: string): VadConfig {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out = { ...VAD_DEFAULTS };
  for (const key of Object.keys(KNOBS) as (keyof VadConfig)[]) {
    const { param, min, max, int } = KNOBS[key];
    const raw = params.get(param);
    if (raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) continue; // 非数值/越界 → 保留默认
    out[key] = int ? Math.floor(n) : n;
  }
  return out;
}
