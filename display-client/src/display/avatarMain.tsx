/**
 * 竖屏首页的形象区(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 2.4)。
 *
 * 手机壳(butler-app 首页)在用户选了某个 Live2D 形象时用 iframe 嵌这一页(`?feed=host`),递进来形象队列与当前选择;
 * 这里只画形象舞台(与横屏展示台左栏同一个组件)。选的是粒子球时壳自己画它那颗球、把这一页卸掉 ——
 * 万一这一页收到的 current 是粒子球,就什么都不画(透明),等壳卸掉。
 */
import '../polyfills-legacy';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AvatarStage } from './AvatarStage';
import { PARTICLES } from './avatarQueue';
import { avatarSelectMessage, postToHost } from './hostFeed';
import { useHostFeed } from './useLiveState';

function AvatarApp() {
  const host = useHostFeed(true);
  const [choice, setChoice] = useState<string | null>(null);
  const hostCurrent = host.avatars?.current;
  useEffect(() => { setChoice(null); }, [hostCurrent]);
  const select = useCallback((id: string) => { setChoice(id); postToHost(avatarSelectMessage(id)); }, []);
  if (host.avatars === null) return null;
  const current = choice ?? host.avatars.current;
  if (current === PARTICLES && choice === null) return null;
  return <AvatarStage items={host.avatars.items} current={current} onSelect={select} particle={null} variant="portrait" />;
}

const container = document.getElementById('root');
if (container !== null) createRoot(container).render(<AvatarApp />);
