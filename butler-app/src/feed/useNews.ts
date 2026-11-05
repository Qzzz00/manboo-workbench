/**
 * 「资讯」页的状态:拉一次 /feed,记住它;反馈先本地动起来再发请求(乐观更新)。
 *
 * **为什么不进 /state**:资讯一天只变一次,而 /state 是一秒一拍的。
 * 把十几条资讯塞进每一拍的快照里,等于为一天一次的变化付一整天的流量
 * (同服务端 /modules 那条的理由)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../session';
import { createNewsApi } from './newsApi';
import { EMPTY_AIDJ, type AidjConfigPatch, type AidjView } from './aidjModel';
import { EMPTY_NEWS, withFeedback, type NewsConfig, type NewsView } from './newsModel';

export interface NewsHandle {
  view: NewsView;
  /** 问过一次了没有。false 时界面说「正在拿」,不说「今天没有」。 */
  asked: boolean;
  /** 这台工作台压根没接资讯(404)。与「接了但今天没有」分得开。 */
  unavailable: boolean;
  error: string | null;
  refresh(): Promise<void>;
  feedback(id: string, action: 'follow' | 'mute'): Promise<void>;
  setConfig(patch: Partial<NewsConfig>): Promise<void>;
  run(): Promise<string>;
  /** 播客音频的本地 URL(拉下来之后的 object URL)。还没拉就是 null。 */
  audioUrl: string | null;
  loadAudio(): Promise<void>;
  audioError: string | null;
  /**
   * 今天那期 Aiboo 双主播节目(2026-09-22)。
   * **这台工作台没接 AIDJ(404)** 时是 null —— 与「接了但今天没有」分得开:
   * 前者整块当不存在、界面照上一版走;后者要说一句为什么(`fallbackNote`)。
   */
  aidj: AidjView | null;
  setAidjConfig(patch: AidjConfigPatch): Promise<void>;
}

export function useNews(session: Session): NewsHandle {
  const api = useMemo(() => createNewsApi(session.client), [session]);
  const [view, setView] = useState<NewsView>(EMPTY_NEWS);
  const [asked, setAsked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [aidj, setAidj] = useState<AidjView | null>(null);
  // object URL 要在换掉/卸载时 revoke,否则每拉一次就漏一份音频在内存里。
  const audioRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.view();
    setAsked(true);
    if (result.ok) {
      setUnavailable(false);
      setError(null);
      setView(result.data);
      return;
    }
    if (result.status === 404) { setUnavailable(true); setError(result.error); return; }
    setError(result.error);
  }, [api]);

  // AIDJ 与 /feed 分开拉:它要去打 Aiboo(几百毫秒到几秒),
  // 串在 /feed 前面会让整页跟着它一起等。
  const refreshAidj = useCallback(async () => {
    const result = await api.aidj();
    // 404 = 这台工作台没接 AIDJ。**不当错误**,整块当不存在,界面照上一版走。
    setAidj(result.ok ? result.data : null);
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshAidj(); }, [refreshAidj]);
  useEffect(() => () => {
    if (audioRef.current !== null) URL.revokeObjectURL(audioRef.current);
  }, []);

  const feedback = useCallback(async (id: string, action: 'follow' | 'mute') => {
    setView(current => withFeedback(current, id, action));
    const result = await api.feedback(id, action);
    // 失败就把真相拉回来:界面上那一条不该因为一次失败的请求而永久消失。
    if (!result.ok) { setError(result.error); await refresh(); }
  }, [api, refresh]);

  const setConfig = useCallback(async (patch: Partial<NewsConfig>) => {
    const result = await api.setConfig(patch);
    if (!result.ok) { setError(result.error); return; }
    setView(current => ({ ...current, config: result.data.config }));
  }, [api]);

  const run = useCallback(async () => {
    const result = await api.run();
    if (!result.ok) { setError(result.error); return result.error; }
    await refresh();
    // 跑完那一轮会把资讯推给 Aiboo,今天那期可能就此生成出来了 —— 顺手再问一遍。
    await refreshAidj();
    return result.data.note;
  }, [api, refresh, refreshAidj]);

  const loadAudio = useCallback(async () => {
    if (audioRef.current !== null) return;
    const result = await api.podcast(view.date === '' ? undefined : view.date);
    if (!result.ok) { setAudioError(result.error); return; }
    const url = URL.createObjectURL(result.data);
    audioRef.current = url;
    setAudioUrl(url);
    setAudioError(null);
  }, [api, view.date]);

  const setAidjConfig = useCallback(async (patch: AidjConfigPatch) => {
    const result = await api.setAidjConfig(patch);
    if (!result.ok) { setError(result.error); return; }
    // 开关一动,今天那期就要重问一遍(关了会回 off,开了要真去取)。
    setAidj(current => ({ ...(current ?? EMPTY_AIDJ), config: result.data.config }));
    await refreshAidj();
  }, [api, refreshAidj]);

  return {
    view, asked, unavailable, error, refresh, feedback, setConfig, run,
    audioUrl, loadAudio, audioError, aidj, setAidjConfig,
  };
}
