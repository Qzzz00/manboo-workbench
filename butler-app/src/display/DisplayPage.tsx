/**
 * 横屏 = 展示台(2026-09-22 Ben 拍板,09-21 那张卡拿掉的入口接回来)。
 *
 * 直接嵌 display-client 的展示台页面(scripts/sync-display.mjs 把它构建到 public/display/)。
 *
 * 2026-09-30(维护者:「Agent 显示都是下线状态」):展示台**不再自己连** /live。手机壳把手上那份 /state
 * 与 Mac 那份粒子参数 postMessage 进去(`?feed=host`,约定见 displayUrl.ts 与 display-client 的 hostFeed.ts):
 *   · 快照一变就递一次;
 *   · 展示台挂上时说一句「我好了」,听到就当场再递一次(iframe 往往比壳慢,第一拍会错过);
 *   · 只递给这一个 iframe、只按同源递 —— 状态里有会话标题,不往别的窗口送。
 * 于是局域网直连、经房间、只用账号登录的手机,横屏看到的都是同一份、新鲜的状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session';
import { useAppearance, useFeed } from '../hooks';
import { avatarSelectFromDisplay, avatarsMessage, displayUrl, hostMessages, iconsMessage, readyFromDisplay } from './displayUrl';
import { useDisplayStyle } from './displayStyle';
import { useAgentIconStore } from '../agents/AgentIcon';
import { avatarLibrary, useAvatarLibrary } from '../avatars/useAvatarLibrary';

export function DisplayPage() {
  const session = useSession();
  const feed = useFeed(session.feed);
  const appearance = useAppearance(session.appearance);
  // 形象队列 + 当前选择(2026-10-01):左栏左右滑 / 快速选择条换形象。
  const avatars = useAvatarLibrary();
  // 展示台样式(2026-10-01,设置 › 声音与形象):换了就换 iframe 地址,当场重载成那一套。
  const { style } = useDisplayStyle();
  // 各家 logo:图要带令牌取,iframe 里取不到 —— 用壳手上那份缓存(agents/agentIcons.ts),取到一张递一张。
  const iconStore = useAgentIconStore();
  const [iconTick, setIconTick] = useState(0);
  useEffect(() => iconStore?.subscribe(() => setIconTick((t) => t + 1)), [iconStore]);
  const iconIds = useMemo(
    () => (feed.state.agent_registry?.entries ?? []).filter((e) => e.icon === true).map((e) => e.id),
    [feed.state.agent_registry],
  );
  useEffect(() => { for (const id of iconIds) iconStore?.want(id); }, [iconIds, iconStore]);
  const icons = useMemo(() => {
    void iconTick; // 取到新图时重算
    return Object.fromEntries(iconIds.map((id) => [id, iconStore?.url(id)]));
  }, [iconIds, iconStore, iconTick]);
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ feed, appearance, avatars, icons });
  latest.current = { feed, appearance, avatars, icons };

  const push = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (target === null || target === undefined) return;
    const { feed: f, appearance: a } = latest.current;
    const origin = typeof window === 'undefined' ? '*' : window.location.origin;
    const lib = latest.current.avatars;
    for (const message of [...hostMessages(f.state, a.preset.settings, f.connected || f.connecting === true), avatarsMessage(lib.stage, lib.choice), iconsMessage(latest.current.icons)]) {
      try { target.postMessage(message, origin); } catch { /* iframe 还没好:它好了会说「我好了」,那时再递 */ }
    }
  }, []);

  // 快照 / 外观一变就递。
  useEffect(() => { push(); }, [feed, appearance, avatars, icons, push]);

  // 展示台说「我好了」→ 当场递一次。只认这个 iframe 发来的。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const picked = avatarSelectFromDisplay(event.data);
      if (picked !== null) { void avatarLibrary().select(picked); return; }
      if (readyFromDisplay(event.data)) push();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [push]);

  return (
    <div className="ba-display" data-reachable="true">
      <iframe key={style} ref={frame} className="ba-display__frame" title="展示台" src={displayUrl(undefined, style)} allow="autoplay" onLoad={push} />
    </div>
  );
}
