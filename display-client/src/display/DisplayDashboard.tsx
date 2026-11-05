/**
 * 展示台仪表盘：**按 v4 布局稿排版，部件全部复用 holo 的**。
 *
 * 布局稿（docs/desktop-workbench-v4.html「展示台」一节）：
 *   左列（约 33%）：Live2D（上）+ 日历（下）
 *   右上：时间 + 天气 + 音乐播放器
 *   右中（最大）：会话，按 agent 分组
 *   右下：余额 / 用量
 *
 * ★这里一行渲染逻辑都不新写：时钟/天气/黄历/一言/唱盘/波形/歌词全部 import 自
 * HoloDashboard（那边是真机上跑通的）。本文件只负责「怎么摆」。
 * 之前我把这些自己重写了一遍，结果口型、封面、歌词、手势全丢，返工了好几轮。
 */
import {
  Turntable, Waveform, fmtMs,
  useAlmanac, useClock, useHitokoto, usePositionMs, useShenzhenWeather,
} from '../holo/HoloDashboard.tsx';
import type { FamilyGroup, QuotaLine } from './displayBoard';
import { MODE_LABELS, type NowPlayingText } from './nowPlaying';
import { QuotaPanel, SessionPanel } from './DisplayPanels.tsx';

export interface DisplayDashboardProps {
  /** 音乐卡上那两行(nowPlaying.ts:歌 / DJ 口播 / 播客主播段 / 没在放时为什么)。 */
  now: NowPlayingText;
  nowCover?: string | null;
  ncmId?: string | null;
  getPositionMs?: () => number;
  getDurationMs?: () => number;
  playing?: boolean;
  djMode?: string;
  analyser?: AnalyserNode | null;
  onPlayPause?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  /** 切「音乐 / 播客」(2026-09-30:竖屏资讯页早有播客,横屏一直只有音乐)。不传就不画那两颗。 */
  onMode?: (mode: string) => void;
  /** 宽扁屏(手机横屏):三栏排法,见 display.css `.dp-dash--wide`。 */
  wide?: boolean;
  groups: readonly FamilyGroup[];
  stale: boolean;
  counts: { waiting: number; done: number; running: number };
  lines: readonly QuotaLine[];
  /**
   * 真实视口宽 ÷ 设计稿宽(1200)。整块仪表盘按这个比例缩放。
   * 由 DisplayApp 算好传进来；这里只负责套上去，不重复算。
   */
  designScale?: number;
  /** 设计空间里的高度 = 真实视口高 ÷ designScale。同样由 DisplayApp 算好传进来。 */
  designHeight?: number;
}

/**
 * ★坑 #7 的修法：每 tick setState 的消费者一律下沉成叶子组件。
 * 原来 useClock（1s）与 usePositionMs（200ms）都挂在 DisplayDashboard 顶层，
 * 于是整棵树（唱盘/波形/歌词/会话/余额）每秒重渲染 5 次；真机上 WebView 渲染进程
 * 被打满到 125~130% CPU，触摸事件排不上队 —— 表现就是「点了没反应、时钟和进度卡住」。
 * 拆开后每次 tick 只重渲染下面这几个小节点，holo 部件本身一行没改。
 */
function DpClock({ weatherText }: { weatherText: string }) {
  const { time, date } = useClock();
  return (
    <div className="dp-time">
      <div className="dp-clock">{time}</div>
      <div className="dp-date">{date}{weatherText}</div>
    </div>
  );
}

function DpSongTime({ getPositionMs, durationMs }: { getPositionMs?: () => number; durationMs: number }) {
  const positionMs = usePositionMs(getPositionMs);
  return <div className="dp-song-time">{fmtMs(positionMs)} / {fmtMs(durationMs)}</div>;
}


export function DisplayDashboard({
  now, nowCover, getPositionMs, getDurationMs,
  playing = false, djMode = 'focus', analyser, onPlayPause, onNext, onPrev, onMode, wide = false,
  groups, stale, counts, lines, designScale = 1, designHeight = 750,
}: DisplayDashboardProps) {
  const weather = useShenzhenWeather();
  const almanac = useAlmanac();
  const hitokoto = useHitokoto();
  const durationMs = getDurationMs ? getDurationMs() : 0;

  // 设计盒子固定 1200 宽（写在 CSS 里），高度按真实视口反推，然后整体缩放。
  // 缩放只此一处：CSS 里所有尺寸都是稿子原值，不做换算（见 display.css 顶部说明）。
  const dashStyle = {
    height: `${Math.round(designHeight)}px`,
    transform: `scale(${designScale})`,
  };

  return (
    <div className={wide ? 'dp-dash dp-dash--wide' : 'dp-dash'} style={dashStyle}>
      {/* 左列下半：日历（上半留空，那是 GL 层画角色的地方） */}
      <section className="dp-card dp-cal">
        <div className="dp-lunar">{almanac.lunarDate}</div>
        <div className="dp-gz">
          {almanac.ganzhiYear}{almanac.jieqi ? ` · ${almanac.jieqi}` : ''}
        </div>
        <div className="dp-yj dp-yi"><span className="dp-tg">宜</span><span>{almanac.yi.join(' · ')}</span></div>
        <div className="dp-yj dp-ji"><span className="dp-tg">忌</span><span>{almanac.ji.join(' · ')}</span></div>
        {hitokoto ? <div className="dp-quote">{hitokoto}</div> : null}
      </section>

      {/* 右上：时间卡 + 音乐卡。
          ★稿子里这是**两张分开的卡片**，不是一张卡中间一条分隔线。
          .dp-topwrap 只负责把两张并排放，本身不画卡片（见 display.css）。 */}
      <div className="dp-topwrap">
        <section className="dp-card dp-clockcard">
          {/* 天气图标在稿子里是时钟左边独立的一枚大图，不再挤在日期那行里 */}
          {weather ? <span className="dp-wx">{weather.icon}</span> : null}
          <DpClock weatherText={weather ? ` · 深圳 ${weather.temp}℃ ${weather.zh}` : ''} />
        </section>

        <section className="dp-card dp-musiccard">
        <div className="dp-player">
          <Turntable
            cover={nowCover}
            playing={playing}
            mode={djMode}
            onPlayPause={onPlayPause}
            onNext={onNext}
            onPrev={onPrev}
          />
          <div className="dp-song">
            <div className="dp-song-title">{now.title}</div>
            <div className="dp-song-artist">{now.sub}</div>
            {/* 进度与「音乐 / 播客」同一行:右栏窄(手机横屏),多占一行额度就少一家。 */}
            <div className="dp-song-row">
              {now.live ? <DpSongTime getPositionMs={getPositionMs} durationMs={durationMs} /> : <span />}
              {onMode !== undefined && (
                <div className="dp-modes" role="group" aria-label="电台 / 播客">
                  {MODE_LABELS.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className="dp-mode"
                      data-on={djMode === m.key}
                      aria-pressed={djMode === m.key}
                      onClick={() => { if (djMode !== m.key) onMode(m.key); }}
                    >{m.label}</button>
                  ))}
                </div>
              )}
            </div>
            {/* 波形只在真有频谱数据时才画。音乐改走原生播放后（真凶是 preferWebAudio），
                音频不再经过 WebAudio 图，analyser 恒为 null——那样画出来是一条永远不动的
                直线，比不画更糟。等哪天音频重新经过 WebAudio，它会自己回来。 */}
            {analyser ? (
              <div className="dp-wave"><Waveform playing={playing} analyser={analyser} /></div>
            ) : null}
          </div>
          {/* 歌词面板在展示台不显示：v4 布局稿右上只有「时间 + 天气 + 音乐播放器」，
              本来就没有歌词区。而这条窄栏会把日文歌词挤成每字一行的竖排贴在屏幕右缘
              （真机上「星-せい-」就是这样，看着像残留的半截文字）。
              holo 那边的歌词面板不受影响，它有整栏宽度。 */}
        </div>
        </section>
      </div>

      {/* 右中（最大）：会话 */}
      <SessionPanel groups={groups} stale={stale} counts={counts} />

      {/* 右下：余额 / 用量 */}
      <QuotaPanel lines={lines} />
    </div>
  );
}
