/**
 * 「资讯」页顶上那块播放器(2026-09-21;2026-10-13 卡「播客页重做」★2 重排)。
 *
 * 维护者 2026-10-13:「这个样式有点丑呢,不像是一个播客的页面」。于是从「一条横栏」
 * 改成**一块播放器**:日期 / 一句话主题一行、一颗大播放键、进度条可拖、底下一行
 * 「已播 / 总长 · 讲到第几条共几条」。黑底白字灰线,不加新颜色。
 *
 * ## 这一版做到哪儿,没做到哪儿(如实)
 *
 * - **做了**:播放、暂停、拖进度、显示已播/总长(总长来自 `<audio>` 自己的 duration,
 *   不是我们按字数估出来的 —— 估出来的时长会被当成真的);
 * - **做了**:整段音频先拉下来(object URL)再播,所以中途断网不会播一半停住;
 * - **做了**(2026-10-13):把 `currentTime` 往外报(`onProgress`),资讯页据此让正在讲的那张卡放大;
 *   `interrupted` 为真时**暂停并记住在播**,它变回假时接着播 —— 她点一张卡去深聊,聊完回来接着听;
 * - **没做**:**后台播与锁屏控制**。Android 上 WebView 里的 `<audio>` 在 App 退到后台
 *   之后会被系统暂停,锁屏那一排控制键要 MediaSession + 一个前台服务的原生插件,
 *   这个包里没有。写进交接的「没做的」,不在这里假装它能。
 */
import { useEffect, useRef, useState } from 'react';

export interface PodcastBarProps {
  /** 音频地址(object URL)。null = 还没拉下来。 */
  src: string | null;
  title: string;
  /** 顶上那一行小字(日期之类)。缺席就不画。 */
  subtitle?: string;
  /** 点播放时如果还没拉过,先去拉。 */
  onNeedAudio(): void;
  /** 拉不下来时那句话(服务端原话)。 */
  error?: string | null;
  onOpenScript(): void;
  /**
   * 播到第几毫秒(2026-10-13)。资讯页用它找「这会儿在讲哪条」。
   * 只在真的在播 / 拖进度时报,**不按定时器空报**。
   */
  onProgress?(ms: number): void;
  /** 讲到第几条、一共几条。缺席(老播客没有分段)就不画那一段。 */
  position?: { at?: number; total: number };
  /**
   * 被打断了(她点开一张卡在深聊)。为真:暂停并记住刚才在播;
   * 变回假:刚才在播就接着播 —— 进度本来就在 `<audio>` 自己身上,不用我们记。
   */
  interrupted?: boolean;
}

/**
 * `<audio>.play()` 在标准浏览器里回 Promise,但**不是所有实现都回**(jsdom 就回 undefined,
 * 老 WebView 也有回 undefined 的)。直接 `.catch()` 会在那些环境里当场抛。
 */
function play(el: HTMLAudioElement | null, onFail: () => void): void {
  if (el === null) return;
  try {
    const started = el.play() as Promise<void> | undefined;
    if (started !== undefined && typeof started.catch === 'function') started.catch(onFail);
  }
  catch { onFail(); }
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PodcastBar(props: PodcastBarProps) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(Number.NaN);
  // 「点了播放但音频还没到」:拉到之后自动接着播,不让他再点一次。
  const [pending, setPending] = useState(false);
  /** 被打断那一下是不是正在播(聊完要不要接着播,看的是这一格)。 */
  const resumeRef = useRef(false);

  useEffect(() => {
    if (!pending || props.src === null) return;
    setPending(false);
    play(ref.current, () => setPlaying(false));
  }, [pending, props.src]);

  /*
   * 打断 / 回来(2026-10-13)。进度不用我们记:`<audio>` 自己的 `currentTime` 本来就留着,
   * 所以这里只管「刚才在不在播」。
   */
  const interrupted = props.interrupted === true;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (interrupted) {
      resumeRef.current = !el.paused;
      if (!el.paused) el.pause();
      return;
    }
    if (resumeRef.current) {
      resumeRef.current = false;
      play(el, () => setPlaying(false));
    }
  }, [interrupted]);

  const seek = (next: number): void => {
    setAt(next);
    props.onProgress?.(next * 1000);
    if (ref.current !== null) ref.current.currentTime = next;
  };

  const toggle = () => {
    if (props.src === null) { setPending(true); props.onNeedAudio(); return; }
    const el = ref.current;
    if (el === null) return;
    if (el.paused) play(el, () => setPlaying(false));
    else el.pause();
  };

  const position = props.position;
  const where = position === undefined || position.total === 0
    ? undefined
    : position.at === undefined ? `共 ${position.total} 条` : `第 ${position.at} / ${position.total} 条`;

  return (
    <div className="ba-podcast ba-podcast--player" role="region" aria-label="资讯播客">
      <div className="ba-podcast__head">
        <p className="ba-podcast__title">{props.title}</p>
        {props.subtitle !== undefined && props.subtitle !== '' && (
          <p className="ba-podcast__sub">{props.subtitle}</p>
        )}
      </div>
      {props.error != null && props.error !== '' && <p className="ba-podcast__err">{props.error}</p>}
      <div className="ba-podcast__row">
        <button
          type="button"
          className="ba-podcast__play"
          aria-label={playing ? '暂停' : '播放'}
          onClick={toggle}
        >{playing ? '❚❚' : '▶'}</button>
        <input
          className="ba-podcast__seek"
          type="range"
          aria-label="进度"
          min={0}
          max={Number.isFinite(total) && total > 0 ? total : 1}
          step={1}
          value={at}
          disabled={props.src === null || !Number.isFinite(total)}
          onChange={e => seek(Number(e.target.value))}
        />
      </div>
      <div className="ba-podcast__foot">
        <p className="ba-podcast__time">{clock(at)} / {clock(total)}</p>
        {where !== undefined && <p className="ba-podcast__where">{where}</p>}
        <button type="button" className="ba-podcast__script" onClick={props.onOpenScript}>文字稿</button>
      </div>
      {props.src !== null && (
        <audio
          ref={ref}
          src={props.src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setAt(0); props.onProgress?.(0); }}
          onTimeUpdate={(e) => {
            setAt(e.currentTarget.currentTime);
            props.onProgress?.(e.currentTarget.currentTime * 1000);
          }}
          onLoadedMetadata={e => setTotal(e.currentTarget.duration)}
        />
      )}
    </div>
  );
}
