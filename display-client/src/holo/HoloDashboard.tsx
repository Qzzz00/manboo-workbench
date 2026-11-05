import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { weatherCodeToCondition } from '../screensaver/lib/weatherCode';
import { getServerBaseUrl } from '../screensaver/lib/serverConfig';
import { currentLyricIndex, parseLyric, type LyricLine } from './holoLyric';
import { applyPomodoroCommand, initialPomodoro, tickPomodoro, type PomodoroState } from './holoPomodoro';
import { computeAlmanac, type HoloAlmanac } from './holoAlmanac';
import { HITOKOTO_URL, parseHitokoto } from './holoHitokoto';
import './holoDashboard.css';

// 全息屏横屏仪表盘（对齐 Figma node 2010:2）：左列时钟+番茄钟，右列满高音乐播放器(黑胶+波形+进度+双语歌词)。
// 只在 holo 入口(data-holo)渲染；移动端主客户端从不渲染本组件。
// 配色照 Figma 白调（浅白磨砂面板 + #404040 深灰字）——Ben 定的方向。

const SHENZHEN = { lat: 22.5431, lon: 114.0579 };

const DJ_MODES = [
  { key: 'focus', label: '音乐' },
  { key: 'commute', label: '播客' },
];

// ── 左下角番茄钟：work → alarm(Stackchan摇头,等摸头) → rest → work…（状态机在 holoPomodoro.ts，单测锁死）──
// 好感度卡(RelationCard)在 Figma 重设计中去掉，右侧改满高音乐播放器。语音改时长走 'set' 命令(main 合入)。
export type PomodoroCommand = { seq: number; action: 'ack' | 'pause' | 'resume' | 'set'; minutes?: number };

function Pomodoro({
  workMinutes = 25,
  onAlarm,
  onAlarmAgain,
  onWorkStart,
  command,
}: {
  workMinutes?: number;
  onAlarm?: () => void;
  onAlarmAgain?: () => void;
  onWorkStart?: () => void;
  command?: PomodoroCommand;
}) {
  const WORK = Math.max(1, Math.round(workMinutes)) * 60;
  const workSecRef = useRef(WORK); // 生效中的专注时长:prop(UI/配置)与语音 set 命令共同的落点
  workSecRef.current = WORK;
  const stRef = useRef<PomodoroState>(initialPomodoro(WORK));
  const [, force] = useState(0);
  const cbRef = useRef({ onAlarm, onAlarmAgain, onWorkStart });
  cbRef.current = { onAlarm, onAlarmAgain, onWorkStart };
  const cmdRef = useRef(command);
  cmdRef.current = command;
  const consumedSeqRef = useRef(command?.seq ?? 0);

  useEffect(() => {
    const t = window.setInterval(() => {
      let acked = false;
      const cmd = cmdRef.current;
      if (cmd && cmd.seq !== consumedSeqRef.current) {
        consumedSeqRef.current = cmd.seq; // 每条命令只消费一次，防陈旧信号秒跳
        if (cmd.action === 'ack') acked = true;
        else if (cmd.action === 'set') {
          // 语音改时长:立即按新时长重开专注(持久化走 App 侧 setPomodoroMin,prop 随后跟上)
          if (cmd.minutes && cmd.minutes > 0) {
            workSecRef.current = Math.round(cmd.minutes) * 60;
            stRef.current = initialPomodoro(workSecRef.current);
          }
        }
        else stRef.current = applyPomodoroCommand(stRef.current, cmd.action);
      }
      const { state, fire } = tickPomodoro(stRef.current, workSecRef.current, acked);
      stRef.current = state;
      force((x) => x + 1);
      if (fire === 'alarm') cbRef.current.onAlarm?.();
      else if (fire === 'alarmAgain') cbRef.current.onAlarmAgain?.();
      else if (fire === 'workStart') cbRef.current.onWorkStart?.();
    }, 1000);
    return () => window.clearInterval(t);
  }, [WORK]);

  const s = stRef.current;
  const mm = String(Math.floor(s.remain / 60)).padStart(2, '0');
  const ss = String(s.remain % 60).padStart(2, '0');
  const label =
    s.phase === 'alarm'
      ? '专注结束！'
      : `${s.phase === 'work' ? '专注' : '休息'}${s.paused ? '(已暂停 ⏸)' : s.phase === 'work' ? '' : '一下'}`;

  return (
    <div className="holo-glass holo-pomodoro">
      <div className="holo-pomo-label">🍅 {label}</div>
      {s.phase === 'alarm' ? (
        <div className="holo-pomo-tip">去摸摸 Stackchan 的头 让它停下来～</div>
      ) : (
        <div className="holo-pomo-time">{mm}:{ss}</div>
      )}
      {/* 刻度尺（纯装饰，对齐 Figma；三角游标居中） */}
      <div className="holo-pomo-ruler" aria-hidden="true">
        <div className="holo-pomo-ruler-cursor" />
      </div>
      {s.phase === 'rest' ? <div className="holo-pomo-tip holo-pomo-tip--rest">该喝口水 · 站一站 · 远眺一下 👀</div> : null}
    </div>
  );
}

export type HoloDashboardProps = {
  nowTitle?: string | null;
  nowArtist?: string | null;
  nowCover?: string | null;
  /** 当前曲目网易云 id（有则拉双语歌词；播客/TTS 无 id 不拉、不显示歌词面板）。 */
  ncmId?: string | null;
  /** 当前播放位置/总长（毫秒，来自 djView.dj.controls）：驱动进度文案 + 歌词高亮同步。 */
  getPositionMs?: () => number;
  getDurationMs?: () => number;
  djMode?: string;
  onSetDjMode?: (mode: string) => void;
  pomodoroWorkMinutes?: number;
  onPomodoroAlarm?: () => void;
  onPomodoroAlarmAgain?: () => void;
  onPomodoroWorkStart?: () => void;
  pomodoroCommand?: PomodoroCommand;
  playing?: boolean;
  analyser?: AnalyserNode | null;
  /** 唱盘交互：点按播放/暂停、左滑下一首、右滑上一首。 */
  onPlayPause?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  /** 替换「左下番茄钟」那一格。展示台放会话区（PRD §6.4 删番茄钟）；holo 不传＝照旧。 */
  slotBottomLeft?: ReactNode;
  /** 追加面板（展示台的余额/用量）。holo 不传＝不渲染。 */
  slotExtra?: ReactNode;
};

export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
  const date = `${now.getMonth() + 1}月${now.getDate()}日 ${week}`;
  return { time: `${hh}:${mm}`, date };
}

type Weather = { temp: number; icon: string; zh: string } | null;
export function useShenzhenWeather(): Weather {
  const [w, setW] = useState<Weather>(null);
  useEffect(() => {
    let alive = true;
    const fetchW = async () => {
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code` +
          `&latitude=${SHENZHEN.lat}&longitude=${SHENZHEN.lon}`;
        const res = await fetch(url);
        const data = await res.json();
        const cur = data?.current ?? {};
        if (!alive) return;
        const cond = weatherCodeToCondition(Number(cur.weather_code) || 0);
        setW({ temp: Math.round(cur.temperature_2m), icon: cond.icon, zh: cond.zh });
      } catch {
        /* 取不到就不显示 */
      }
    };
    void fetchW();
    const t = window.setInterval(fetchW, 10 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return w;
}

/** 黄历：本地计算,每分钟核对日期串,跨天自动翻页。 */
export function useAlmanac(): HoloAlmanac {
  const [a, setA] = useState<HoloAlmanac>(() => computeAlmanac(new Date()));
  const dayRef = useRef(new Date().toDateString());
  useEffect(() => {
    const t = window.setInterval(() => {
      const day = new Date().toDateString();
      if (day !== dayRef.current) {
        dayRef.current = day;
        setA(computeAlmanac(new Date()));
      }
    }, 60 * 1000);
    return () => window.clearInterval(t);
  }, []);
  return a;
}

/** 一言：挂载拉一次+每小时刷,8s超时,失败置null整行隐藏。 */
export function useHitokoto(): string | null {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const fetchOne = async () => {
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(HITOKOTO_URL, { signal: ctl.signal });
        const data = await res.json();
        if (alive) setLine(parseHitokoto(data));
      } catch {
        /* 拉不到就不显示 */
      } finally {
        window.clearTimeout(timer);
      }
    };
    void fetchOne();
    const t = window.setInterval(fetchOne, 60 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return line;
}

/** 轮询当前播放位置（毫秒），驱动进度 + 歌词高亮。getter 放 ref 避免每帧重订阅。 */
export function usePositionMs(getPositionMs?: () => number): number {
  const getRef = useRef(getPositionMs);
  getRef.current = getPositionMs;
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => {
      const g = getRef.current;
      setPos(g ? g() : 0);
    }, 200);
    return () => window.clearInterval(t);
  }, []);
  return pos;
}

/** ncmId 变化时拉一次双语歌词；无 id / 拉不到返回空数组（前端据此隐藏歌词面板）。 */
export function useLyric(ncmId?: string | null): LyricLine[] {
  const [lines, setLines] = useState<LyricLine[]>([]);
  useEffect(() => {
    if (!ncmId) {
      setLines([]);
      return;
    }
    let alive = true;
    const base = getServerBaseUrl().replace(/\/+$/, '');
    fetch(`${base}/api/track/lyric?ncm_id=${encodeURIComponent(ncmId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setLines(parseLyric(d?.lrc, d?.tlyric));
      })
      .catch(() => {
        if (alive) setLines([]);
      });
    return () => {
      alive = false;
    };
  }, [ncmId]);
  return lines;
}

export function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 音乐波形可视化：接了 analyser 就跟真实频谱，否则 idle 正弦动画。 */
export function Waveform({ playing, analyser }: { playing: boolean; analyser?: AnalyserNode | null }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const BARS = 40;
    let raf = 0;
    let t = 0;
    const freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (analyser && freq) analyser.getByteFrequencyData(freq);
      const bw = w / BARS;
      const hasRoundRect = typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === 'function';
      for (let i = 0; i < BARS; i++) {
        // ★只画真实频谱。原来在没有 analyser 时画一条合成正弦——它会在完全没有声音时
        // 照样起伏，把「音乐已经死了」伪装成一切正常（本轮真机排查被它误导过：
        // Ben 看到波形在动以为在播，实际 musicAnalyser 为 null、一点声音都没有）。
        // 没有真数据就保持静止基线，让波形成为「有没有声音」的诚实指示器。
        const v = analyser && freq ? freq[Math.floor((i / BARS) * freq.length)] / 255 : 0;
        const barH = Math.max(2, v * h);
        const x = i * bw + bw * 0.2;
        const y = (h - barH) / 2;
        // 深灰竖条（对齐 Figma #404040 波形）
        ctx.fillStyle = 'rgba(64, 64, 64, 0.85)';
        const bwEff = bw * 0.5;
        // ★ctx.roundRect 是 Chrome 99+；ThinkSmart View 出厂 WebView 是 Chrome 61，
        // 调用直接抛 TypeError。而 requestAnimationFrame(draw) 在本函数末尾 → 异常会把
        // **整个 rAF 循环打死**，波形从第一帧起就永久空白（真机实测：只报 6 条错，不是每帧一条）。
        // 圆角半径 ≤1.5px、柱宽仅几 px，退化成直角肉眼无差。
        if (hasRoundRect) {
          const r = Math.min(bwEff / 2, 1.5);
          ctx.beginPath();
          ctx.roundRect(x, y, bwEff, barH, r);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, bwEff, barH);
        }
      }
      t += 1;
      // 无真频谱时画一帧静止基线即停，不空转 rAF（这台弱机上还能省下 WebView 的每帧合成）。
      if (!analyser) return;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing, analyser]);
  return <canvas ref={ref} className="holo-wave" aria-hidden="true" />;
}

/** 黑胶唱机：CSS 画唱片(黑胶+纹路)，中心嵌封面；播放时匀速旋转。唱臂随播放压到唱片。 */
/** 唱盘手势判定阈值：滑动位移(px) 与 单击最长时长(ms)。触摸屏上 40px 足够区分点按与滑动。 */
const SWIPE_PX = 40;
const TAP_MS = 700;

export function Turntable({
  cover, playing, mode, onPlayPause, onNext, onPrev,
}: {
  cover?: string | null; playing: boolean; mode: string;
  onPlayPause?: () => void; onNext?: () => void; onPrev?: () => void;
}) {
  // 点一下=播放/暂停；左滑=下一首；右滑=上一首。
  // ★必须 setPointerCapture：手指滑出唱盘后 pointerup 仍要落回本元素，否则滑动判定收不到终点。
  // ★CSS 侧还要 touch-action:none + user-select:none，否则长按会触发选字并发 pointercancel，
  //   手势直接断掉（掌机 PTT 踩过同一个坑）。
  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 老 WebView 兜底 */ }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = startRef.current;
    startRef.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) onNext?.();
      else onPrev?.();
      return;
    }
    if (Math.abs(dx) < SWIPE_PX && Math.abs(dy) < SWIPE_PX && Date.now() - s.t <= TAP_MS) {
      onPlayPause?.();
    }
  };

  return (
    <div
      className="holo-turntable"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { startRef.current = null; }}
      role="button"
      aria-label="点击播放或暂停，左滑下一首，右滑上一首"
    >
      <div className={`holo-vinyl${playing ? ' holo-vinyl--spin' : ''}`}>
        {/* 封面探针已撤：它证明了图片本身能加载（三张全部"加载成功"），使命完成。
            留着是净负担——每首歌都会多解一张整尺寸封面进内存，而渲染进程正在查内存泄漏。
            真正的修复是下面 url() 那对引号 + 预热效果，探针不必常驻。 */}
        <div className="holo-vinyl-label" style={cover ? { backgroundImage: `url("${cover}")` } : undefined}>
          {cover ? null : <span className="holo-vinyl-note">{mode === 'commute' ? '🎙' : '♪'}</span>}
          <span className="holo-vinyl-hole" />
        </div>
      </div>
      <div className={`holo-tonearm${playing ? ' holo-tonearm--on' : ''}`} aria-hidden="true">
        <span className="holo-tonearm-pivot" />
        <span className="holo-tonearm-bar" />
        <span className="holo-tonearm-head" />
      </div>
    </div>
  );
}

/** 双语歌词面板：当前行高亮加粗、自动滚到可视中部；空则不渲染（纯音乐/无歌词降级）。 */
export function LyricPanel({ lines, positionMs }: { lines: LyricLine[]; positionMs: number }) {
  const idx = currentLyricIndex(lines, positionMs);
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [idx]);
  if (!lines.length) return null;
  return (
    <div className="holo-lyrics">
      {lines.map((l, i) => (
        <div
          key={i}
          ref={i === idx ? activeRef : undefined}
          className={`holo-lyric-line${i === idx ? ' holo-lyric-line--on' : ''}`}
        >
          <div className="holo-lyric-en">{l.text}</div>
          {l.trans ? <div className="holo-lyric-zh">{l.trans}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function HoloDashboard({
  nowTitle,
  nowArtist,
  nowCover,
  ncmId,
  getPositionMs,
  getDurationMs,
  djMode = 'focus',
  pomodoroWorkMinutes = 25,
  onPomodoroAlarm,
  onPomodoroAlarmAgain,
  onPomodoroWorkStart,
  pomodoroCommand,
  playing = false,
  analyser,
  onPlayPause,
  onNext,
  onPrev,
  slotBottomLeft,
  slotExtra,
}: HoloDashboardProps) {
  const { time, date } = useClock();
  const weather = useShenzhenWeather();
  const almanac = useAlmanac();
  const hitokoto = useHitokoto();
  const positionMs = usePositionMs(getPositionMs);
  const lyrics = useLyric(ncmId);
  const durationMs = getDurationMs?.() ?? 0;
  const modeLabel = DJ_MODES.find((m) => m.key === djMode)?.label ?? '音乐';

  return (
    <div className="holo-dash holo-dash--figma">
      {/* 左侧白色渐变蒙版：让左列文字压在角色上可读（对齐 Figma node 2010:8） */}
      <div className="holo-left-scrim" aria-hidden="true" />

      {/* 左上：日期 + 大时钟 + 天气 */}
      <div className="holo-glass holo-clock">
        <div className="holo-date">{date}</div>
        <div className="holo-clock-time">{time}</div>
        <div className="holo-weather">
          <span className="holo-weather-main">
            <span className="holo-weather-icon">{weather ? weather.icon : '☁'}</span>
            {weather ? `${weather.temp}℃ · ${weather.zh}` : '—'}
          </span>
          <span className="holo-weather-city">深圳</span>
        </div>
      </div>

      {/* 左中：黄历 + 一言（无底板悬浮，Ben 拍板；黄历本地计算断网照常，一言可缺席） */}
      <div className="holo-almanac">
        <div className="holo-almanac-date">{almanac.lunarDate}</div>
        <div className="holo-almanac-sub">
          {almanac.ganzhiYear}
          {almanac.jieqi ? ` · ${almanac.jieqi}` : ''}
        </div>
        <div className="holo-almanac-line"><span className="holo-almanac-tag">宜</span>{almanac.yi.join(' · ')}</div>
        <div className="holo-almanac-line"><span className="holo-almanac-tag">忌</span>{almanac.ji.join(' · ')}</div>
        {hitokoto ? <div className="holo-almanac-quote">{hitokoto}</div> : null}
      </div>

      {/* 左下：番茄钟。展示台传 slotBottomLeft 把这块换成会话区（PRD §6.4 删掉番茄钟）；
          holo 不传 → 照旧渲染番茄钟，行为零变化。 */}
      {slotBottomLeft ?? (
        <Pomodoro
          workMinutes={pomodoroWorkMinutes}
          onAlarm={onPomodoroAlarm}
          onAlarmAgain={onPomodoroAlarmAgain}
          onWorkStart={onPomodoroWorkStart}
          command={pomodoroCommand}
        />
      )}
      {/* 展示台追加的面板（余额/用量）。holo 不传就什么都不渲染。 */}
      {slotExtra}

      {/* 右侧：满高音乐播放器药丸（纯展示——全息屏不可点，控制走语音） */}
      <div className="holo-glass holo-player">
        <svg className="holo-player-arc" viewBox="0 0 280 96" aria-hidden="true">
          <path id="holo-arc-path" d="M 50 90 A 97.5 97.5 0 0 1 230 90" fill="none" />
          <text className="holo-player-arc-text">
            <textPath href="#holo-arc-path" startOffset="50%" textAnchor="middle">
              • MUSIC PLAYER •
            </textPath>
          </text>
        </svg>

        <Turntable
          cover={nowCover}
          playing={playing}
          mode={djMode}
          onPlayPause={onPlayPause}
          onNext={onNext}
          onPrev={onPrev}
        />

        <div className="holo-song">
          <div className="holo-song-title">{nowTitle || '未在播放'}</div>
          <div className="holo-song-artist">{nowArtist || (djMode === 'commute' ? '播客' : '—')}</div>
          <span className="holo-song-clef" aria-hidden="true">🎼</span>
        </div>

        <div className="holo-player-wave">
          <Waveform playing={playing} analyser={analyser} />
        </div>

        <div className="holo-progress">
          {fmtMs(positionMs)} / {durationMs > 0 ? fmtMs(durationMs) : '--:--'}
        </div>

        <LyricPanel lines={lyrics} positionMs={positionMs} />
        {!lyrics.length ? (
          <div className="holo-lyrics-empty">{ncmId ? '纯音乐 · 请欣赏' : `${modeLabel}模式`}</div>
        ) : null}
      </div>

    </div>
  );
}
