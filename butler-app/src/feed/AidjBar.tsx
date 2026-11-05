/**
 * 「AIDJ 通勤播客」播放条(2026-09-22)。播 Aiboo 那套**双主播对话**节目。
 *
 * 与上一版那条 `PodcastBar`(单人口播、一整段 mp3)的区别:
 * 这一期是 **68 段小音频**,要**按序播**、播完一段接下一段,并且把**当前谁在说、说什么**
 * 显示出来 —— 这是双主播节目跟一段独白最大的不同,不显示就看不出来。
 *
 * ## 搬了什么、没搬什么
 *
 * 思路来自 Aiboo 自己的 `src/screensaver/lib/djClient.ts`(`playCommuteSegment`):
 * 一段 `ended` 就推进下一段、没有音频的段按字数停留。**只搬这一条**。
 *
 * **没搬**:Live2D 口型(任务卡明写了不搬)、原生前台 Service 与锁屏控制
 * (那要原生插件,这个包里没有——同上一版「没做的」第 1 条)、蓝牙媒体键。
 * 所以:**退到后台仍然会被系统暂停**。这一条在交接里如实记着,界面上不假装它能。
 *
 * ## 音频从哪儿来
 *
 * 地址是**指向 Aiboo 的绝对地址**(服务端 `aidj.ts` 拼好的),手机**直接去拉**,
 * 不经工作台。所以出了局域网照样听得了 —— 上一版 `/feed/podcast` 走不了房间代理,
 * 恰好在通勤路上不工作。
 */
import { useEffect, useRef, useState } from 'react';
import {
  BED_VOLUME, clampIndex, dwellMs, isFinished, isTextOnly, nextIndex, programTitle,
  progressLabel, segmentAt, topicAt, type AidjProgram,
} from './aidjModel';

export interface AidjBarProps {
  program: AidjProgram;
  /** 退回单人口播时那一句话(这里是 undefined,能播就没有)。 */
  note?: string;
  /** 点话题卡片:用系统浏览器打开原文。 */
  onOpenTopic(url: string): void;
}

/**
 * `<audio>.play()` 在标准浏览器里回 Promise,但**不是所有实现都回**(jsdom 回 undefined,
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

export function AidjBar(props: AidjBarProps) {
  const { program } = props;
  const ref = useRef<HTMLAudioElement>(null);
  const bedRef = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const segment = segmentAt(program, index);
  const finished = isFinished(program, index);
  const topic = topicAt(program, index);

  // 没有音频的那一段(Aiboo 那行 TTS 失败了):按字数停留,照样往下走,
  // 文字仍然显示 —— 用户读得到,节目不会卡死在这一段。
  useEffect(() => {
    if (!playing || segment === undefined || segment.audio_url !== undefined) return;
    const timer = setTimeout(() => { setIndex(current => nextIndex(program, current)); }, dwellMs(segment));
    return () => { clearTimeout(timer); };
  }, [playing, segment, program]);

  // 换了一段就接着播(用户没有按暂停的话)。
  useEffect(() => {
    if (!playing || segment?.audio_url === undefined) return;
    play(ref.current, () => { setFailed('这一段音频拉不下来'); });
  }, [playing, segment?.audio_url, index]);

  // 音乐床:低音量循环垫底。**Aiboo 现在不给音乐床**(它自己拿掉了,说盖住人声),
  // 所以这一段平时根本不跑;字段还在,哪天它加回来这边不用改。
  useEffect(() => {
    const bed = bedRef.current;
    if (bed === null) return;
    bed.volume = BED_VOLUME;
    if (playing && !finished) play(bed, () => { /* 床放不出来不影响口播 */ });
    else bed.pause();
  }, [playing, finished]);

  const toggle = () => {
    if (finished) { setIndex(0); setPlaying(true); return; }
    if (playing) {
      setPlaying(false);
      ref.current?.pause();
      return;
    }
    setPlaying(true);
    if (segment?.audio_url !== undefined) play(ref.current, () => { setFailed('这一段音频拉不下来'); });
  };

  const jump = (delta: number) => {
    setFailed(null);
    setIndex(current => clampIndex(program, current + delta));
  };

  return (
    <div className="ba-podcast ba-podcast--aidj" role="region" aria-label="资讯播客">
      <div className="ba-podcast__row">
        <button
          type="button"
          className="ba-podcast__play"
          aria-label={playing && !finished ? '暂停' : '播放'}
          onClick={toggle}
        >{playing && !finished ? '❚❚' : '▶'}</button>
        <div className="ba-podcast__body">
          <p className="ba-podcast__title">{programTitle(program)}</p>
          <p className="ba-podcast__time">{progressLabel(program, index)}</p>
        </div>
        <button type="button" className="ba-podcast__skip" aria-label="上一段" onClick={() => jump(-1)}>⤒</button>
        <button type="button" className="ba-podcast__skip" aria-label="下一段" onClick={() => jump(1)}>⤓</button>
      </div>

      {finished
        ? <p className="ba-podcast__line" role="status">本期播完了。</p>
        : segment !== undefined && (
          <p className="ba-podcast__line">
            <span className="ba-podcast__speaker">{segment.speaker}</span>
            <span className="ba-podcast__text">{segment.text}</span>
          </p>
        )}

      {topic !== undefined && (
        <button type="button" className="ba-podcast__topic" onClick={() => { props.onOpenTopic(topic.url); }}>
          {topic.title}
          {topic.source !== '' && <span className="ba-podcast__src">{topic.source}</span>}
        </button>
      )}

      {isTextOnly(program) && (
        <p className="ba-podcast__err" role="status">这一期 Aiboo 那边一段音频都没合成出来,只能当文字稿读。</p>
      )}
      {failed !== null && <p className="ba-podcast__err" role="alert">{failed}</p>}
      {props.note !== undefined && <p className="ba-podcast__note">{props.note}</p>}

      {segment?.audio_url !== undefined && (
        <audio
          ref={ref}
          src={segment.audio_url}
          preload="none"
          onEnded={() => { setIndex(current => nextIndex(program, current)); }}
          // 某一段拉不下来不该把整期卡死:如实说一句,然后跳过它继续。
          onError={() => {
            setFailed('有一段音频拉不下来,跳过了');
            setIndex(current => nextIndex(program, current));
          }}
        />
      )}
      {program.bed !== undefined && <audio ref={bedRef} src={program.bed.url} loop preload="none" />}
    </div>
  );
}
