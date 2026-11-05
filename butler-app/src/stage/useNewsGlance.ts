/**
 * 首页自己拉的那一份资讯。今天只喂一样东西:球下那一排里**资讯那颗的小点**
 * (今天那期播客能听就亮;2026-10-03 晚维护者:「要,只标播客有没有」),亮不亮认 `glancePodcast`。
 *
 * 挂上时问一次 `GET /feed` 与 `GET /feed/aidj`(与资讯页同一个 ApiClient:局域网直连 8791,
 * 出了门经房间代理),之后每 15 分钟(藏在后台时不问)、以及从后台切回来时再问一次。两样都要问:播客可能是
 * Aiboo 那期双主播(`/feed/aidj`,工作台要去打 Aiboo 云端),也可能是工作台自己合成的那段(`/feed`)。
 * 调用方只在那颗画着时打开它(`enabled`)。
 *
 * **不进 /state**:资讯一天只变一次,理由同 feed/useNews.ts 顶上那段。
 * 404 = 这台工作台没接资讯(老版本),与「接了但今天没有」分开(`unavailable`)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '../session';
import { createNewsApi } from '../feed/newsApi';
import type { NewsGlance } from './stageCardsModel';

/** 多久再问一次。资讯一天只变一次,15 分钟足够赶上早报那一下。 */
export const NEWS_GLANCE_REFRESH_MS = 15 * 60 * 1000;

export function useNewsGlance(session: Session, options: { refreshMs?: number; enabled?: boolean } = {}): NewsGlance {
  const enabled = options.enabled !== false;
  const api = useMemo(() => createNewsApi(session.client), [session]);
  const [glance, setGlance] = useState<NewsGlance>({ asked: false, unavailable: false });

  const refresh = useCallback(async () => {
    // 两样分开问:AIDJ 要去打 Aiboo(几百毫秒到几秒),不让 /feed 等它。
    const [view, aidj] = await Promise.all([
      api.view().catch((error: unknown) => ({ ok: false as const, status: 0, error: error instanceof Error ? error.message : '连不上电脑' })),
      api.aidj().catch(() => ({ ok: false as const, status: 0, error: '' })),
    ]);
    setGlance({
      asked: true,
      unavailable: !view.ok && view.status === 404,
      ...(view.ok ? { view: view.data } : view.status === 404 ? {} : { error: view.error }),
      aidj: aidj.ok ? aidj.data : null,
    });
  }, [api]);

  useEffect(() => {
    // 关着就不问(通话里、引导里那一排不画;AIDJ 那一问要打 Aiboo,别在电话里多一份活)。
    if (!enabled) return undefined;
    void refresh();
    const every = options.refreshMs ?? NEWS_GLANCE_REFRESH_MS;
    // 藏在后台(锁屏 / 切到别的 App)时到点不问:后台来电那张卡开了常驻前台服务,WebView 在后台照样跑,
    // 那时这颗点没人看,别每 15 分钟让电脑去打一次 Aiboo。切回来那一下(下面 onVisible)补问一次。
    const timer = every > 0 ? setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, every) : undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, options.refreshMs, enabled]);

  return glance;
}
