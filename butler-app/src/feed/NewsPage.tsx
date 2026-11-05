/**
 * 手机「资讯」页(2026-09-21;2026-10-13 卡「播客页重做」重排)。
 *
 * 维护者 2026-09-21:「根据项目情况和偏好在手机端上做信息资讯和播客」。
 * 维护者 2026-10-13:「播客是 OK 的,就是这个样式有点丑呢,不像是一个播客的页面……
 * 语音播放到哪一条的时候,被讲到的资讯卡片能有一个放大的效果……我点击之后,可以打断正在播放的
 * 播客,我可以与事务官针对这条信息进行深入挖掘和交流」。
 *
 * 一页三层:
 *   顶上  —— 一块播放器(`PodcastBar`:日期 / 主题 / 播放暂停 / 进度 / 讲到第几条)。
 *            **2026-09-22 起首选 Aiboo 的双主播节目**(`AidjBar`,按序播口播段);
 *            取不到才退回单人口播,并在下面用一行小字说清楚为什么 —— Aiboo / 工作台的原话,不粉饰;
 *   中间  —— 按项目分组的条目:标题、来源、**一句话为什么相关**、跟进 / 不看了。
 *            **正在讲的那一条放大 + 边框亮**(灰白,不加新色)并自动滚到可见;
 *            没有 `segments` 的老播客照旧不亮(宁可不亮,也不猜这会儿在讲第几条);
 *   点一张 —— **打断播客 → 深聊那一层**(`DigSheet`)。原文改成卡上一颗「原文」键
 *            —— 一张卡上两种「点」,主的那一下给深聊(她原话里点卡就是为了聊)。
 *
 * **空的时候说的话分三种**(newsModel.emptyNote):没问到 / 中转没配搜索 / 确实没搜到。
 * 一句「暂无资讯」把这三件事糊在一起,等于什么都没说。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session';
import { useNews } from './useNews';
import {
  emptyNote, metaLine, playablePodcast, podcastNote, speakingItemId, speakingPosition, type NewsItem,
} from './newsModel';
import { PodcastBar } from './PodcastBar';
import { AidjBar } from './AidjBar';
import { DigSheet } from './DigSheet';
import { createDigApi } from './digApi';
import { fallbackNote } from './aidjModel';
import { useBackHandler } from '../nav/back';
import type { AsrResult } from '../api/voice';

/** 用系统浏览器开。Capacitor 里 `target="_blank"` 的链接默认交给系统处理。 */
export function openExternal(url: string): void {
  try { window.open(url, '_blank', 'noopener,noreferrer'); }
  catch { /* 开不了就算了 —— 一条打不开的链接不该把整页弄崩 */ }
}

export interface NewsPageProps {
  /**
   * 「打电话聊」:切回首页并开一通。缺席 = 那颗键灰掉并写明原因(`DigSheet` 的 `DIG_CALL_OFF`)。
   * 通话本体在首页那一层(StagePage 的 CallOverlay),这一页只负责**先告诉电脑这一通为哪条打**。
   */
  onCall?(): void;
}

function Item({ item, speaking, onFeedback, onDig }: {
  item: NewsItem;
  /** 播客这会儿讲的就是这一条。 */
  speaking: boolean;
  onFeedback(id: string, action: 'follow' | 'mute'): void;
  onDig(item: NewsItem): void;
}) {
  const meta = metaLine(item);
  const ref = useRef<HTMLLIElement>(null);
  /*
   * 讲到这一条就滚到可见。`block: 'nearest'` —— 已经在屏上的不要无谓地跳一下。
   * 可选调用:`scrollIntoView` 在 jsdom 里压根没有实现,滚不动不该把整页弄崩。
   */
  useEffect(() => {
    if (speaking) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [speaking]);
  return (
    <li className="ba-news__item" ref={ref} data-followed={item.feedback === 'follow'} data-speaking={speaking}>
      <button type="button" className="ba-news__open" onClick={() => onDig(item)}>
        <span className="ba-news__title">{item.title}</span>
        {meta !== '' && <span className="ba-news__meta">{meta}</span>}
        <span className="ba-news__why">{item.why}</span>
      </button>
      <div className="ba-news__acts">
        <button type="button" className="ba-news__act" onClick={() => onDig(item)}>聊这条</button>
        <button type="button" className="ba-news__act" onClick={() => openExternal(item.url)}>原文</button>
        <button
          type="button"
          className="ba-news__act"
          data-on={item.feedback === 'follow'}
          onClick={() => onFeedback(item.id, 'follow')}
        >{item.feedback === 'follow' ? '已跟进' : '跟进'}</button>
        <button type="button" className="ba-news__act" onClick={() => onFeedback(item.id, 'mute')}>不看了</button>
      </div>
    </li>
  );
}

export function NewsPage(props: NewsPageProps = {}) {
  const session = useSession();
  const news = useNews(session);
  const digApi = useMemo(() => createDigApi(session.client), [session]);
  const [script, setScript] = useState(false);
  /** 正在深聊的那一条(null = 没开)。开着就等于「播客被打断了」。 */
  const [dig, setDig] = useState<NewsItem | null>(null);
  /** 播到第几毫秒(播放器往外报的)。 */
  const [atMs, setAtMs] = useState(0);
  // 系统返回(2026-09-24,卡 fix/phone-nav-back):深聊那一层、文字稿那一层开着先收它。
  useBackHandler(script, () => setScript(false));
  useBackHandler(dig !== null, () => setDig(null));
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const podcast = news.view.podcast;
  const bar = podcastNote(podcast);
  const empty = news.view.groups.length === 0;
  // 首选 AIDJ 的双主播节目;它播不了才退回单人口播那一支。
  // 哪一样算「能听」只在 playablePodcast 里判一遍 —— 首页资讯那颗的小点认的也是它。
  const playable = playablePodcast(news.view, news.aidj);
  const aidjNote = news.aidj === null ? undefined : fallbackNote(news.aidj);
  // 这会儿在讲哪一条:只认 newsModel 那一处(两处各判一遍早晚不一致)。
  const speaking = speakingItemId(podcast?.segments, atMs);
  const position = speakingPosition(podcast?.segments, atMs);

  const transcribe = useCallback(async (wav: Blob): Promise<AsrResult> => await session.voice.asr(wav), [session]);

  return (
    <div className="ba-news">
      {news.unavailable
        ? <p className="ba-news__empty" role="status">{news.error ?? '这台工作台还没接资讯这一块。'}</p>
        : (
          <>
            {playable?.kind === 'aidj'
              ? <AidjBar program={playable.program} onOpenTopic={openExternal} />
              : (
                <>
                  {aidjNote !== undefined && <p className="ba-podcast__note" role="status">{aidjNote}</p>}
                  {bar !== undefined && (
                    playable?.kind === 'local'
                      ? (
                        <PodcastBar
                          src={news.audioUrl}
                          title={bar}
                          {...(news.view.date === '' ? {} : { subtitle: news.view.date })}
                          error={news.audioError}
                          onNeedAudio={() => { void news.loadAudio(); }}
                          onOpenScript={() => setScript(true)}
                          onProgress={setAtMs}
                          position={position}
                          interrupted={dig !== null}
                        />
                      )
                      : (
                        <div className="ba-podcast ba-podcast--textonly" role="status">
                          <p className="ba-podcast__title">{bar}</p>
                          {podcast !== undefined && podcast.script !== '' && (
                            <button type="button" className="ba-podcast__script" onClick={() => setScript(true)}>文字稿</button>
                          )}
                        </div>
                      )
                  )}
                </>
              )}

            {empty
              ? <p className="ba-news__empty" role="status">{emptyNote(news.view, news.asked)}</p>
              : news.view.groups.map(group => (
                <section className="ba-news__group" key={group.project_id}>
                  <h2 className="ba-news__h">{group.project_name}</h2>
                  <ul className="ba-list ba-news__list">
                    {group.items.map(item => (
                      <Item
                        key={item.id}
                        item={item}
                        speaking={speaking === item.id}
                        onFeedback={(id, action) => { void news.feedback(id, action); }}
                        onDig={setDig}
                      />
                    ))}
                  </ul>
                </section>
              ))}

            {news.error !== null && !news.unavailable && <p className="ba-news__err" role="alert">{news.error}</p>}
            {note !== null && <p className="ba-news__note" role="status">{note}</p>}

            <button
              type="button"
              className="ba-btn ba-news__run"
              disabled={running}
              onClick={() => {
                setRunning(true);
                setNote('在搜了,要一会儿…');
                void news.run().then((text) => { setNote(text); }).finally(() => setRunning(false));
              }}
            >{running ? '在搜了…' : '现在搜一轮'}</button>
          </>
        )}

      {dig !== null && (
        <DigSheet
          item={dig}
          api={digApi}
          transcribe={transcribe}
          onOpenLink={openExternal}
          onClose={() => setDig(null)}
          {...(props.onCall === undefined ? {} : { onCall: () => { setDig(null); props.onCall?.(); } })}
        />
      )}

      {script && podcast !== undefined && (
        <div className="ba-sheet" role="dialog" aria-label="播客文字稿">
          <div className="ba-sheet__card">
            <p className="ba-sheet__title">{podcast.date} 的口播稿</p>
            <p className="ba-news__script">{podcast.script === '' ? (podcast.error ?? '今天没有稿子。') : podcast.script}</p>
            <button type="button" className="ba-btn" onClick={() => setScript(false)}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
