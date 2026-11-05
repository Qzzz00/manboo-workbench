/**
 * 第二套横屏展示台「环绕」(2026-10-01,维护者:「做手机新的一个横屏展示台,Codex 在 Pen.dev 做好了」)。
 *
 * 稿子:Pen.dev 画布「B · 可编辑主稿 · 六家账号」「B · 九个接入账号 · 同屏密度」「B · 单账号 · 两个会话」,873×393。
 *   顶栏:时间 · 日期 / 正在放的那一首 + 暂停;
 *   中间:形象位(粒子球 / Live2D,左右滑换)居中,两侧是会话卡,**只有在跑的**用细线连到球;
 *   底下:额度按账号三列,全部周期都摆。
 * 尺寸、色值照稿子原值写在 orbit.css 里(873 宽的设计空间),整体按真实视口缩放 —— 缩放只此一处,同第一套。
 * 数据、音乐、形象舞台全是第一套那几样(DisplayApp 里同一份),这里只管怎么摆。没有一个按钮会改工作台(PRD §6.3)。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { NowPlayingText } from './nowPlaying';
import { splitSides, type OrbitCard, type QuotaAccount, type QuotaWindowView } from './orbitBoard';
import './orbit.css';

/** 设计稿宽度(Pen.dev 那三张都是 873×393,正好是维护者那台手机的横屏 CSS 视口)。 */
export const ORBIT_DESIGN_WIDTH = 873;
/** 账号多过这个数,会话卡收紧(稿子「九个接入账号」那一张)。 */
export const DENSE_ACCOUNTS = 6;

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function orbitDate(now: Date): string {
  return `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 每秒跳的只有这一小块(同第一套坑 #7:tick 的消费者下沉成叶子,别让整棵树每秒重画)。 */
function OrbitClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="ob-when">
      <span className="ob-clock">{pad(now.getHours())}:{pad(now.getMinutes())}</span>
      <span className="ob-date">{orbitDate(now)}</span>
    </div>
  );
}

export interface Box { x: number; y: number; w: number; h: number }

/** 卡片到球的那条细线:从卡片靠球那一侧的中点水平出发,落到球的侧沿。 */
export function connectorPath(card: Box, orb: { x: number; y: number }, side: 'left' | 'right', reach = 70): string {
  const y1 = card.y + card.h / 2;
  const x1 = side === 'left' ? card.x + card.w : card.x;
  const x2 = side === 'left' ? orb.x - reach : orb.x + reach;
  const y2 = orb.y + (y1 - orb.y) * 0.3;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

function Mark({ id, icons, colors, size }: { id: string; icons: Record<string, string>; colors: Record<string, string>; size: number }) {
  const url = icons[id];
  if (url !== undefined) return <img className="ob-mark" src={url} alt="" aria-hidden="true" width={size} height={size} />;
  return <i className="ob-mark ob-mark--dot" aria-hidden="true" style={{ background: colors[id] ?? '#9C9C9C' }} />;
}

function SessionCard({ card, icons, colors }: { card: OrbitCard; icons: Record<string, string>; colors: Record<string, string> }) {
  return (
    <div className="ob-card" data-key={card.key} data-status={card.status} data-linked={card.linked} data-ringing={card.ringing}>
      <div className="ob-card__head">
        <span className="ob-card__who"><Mark id={card.agentId} icons={icons} colors={{ ...colors, ...(card.color === undefined ? {} : { [card.agentId]: card.color }) }} size={12} />{card.agentName}</span>
        <span className="ob-card__state"><i />{card.statusText}</span>
      </div>
      <div className="ob-card__title">{card.title}</div>
      {card.sub !== '' && <div className="ob-card__sub">{card.sub}</div>}
    </div>
  );
}

function Window({ w }: { w: QuotaWindowView }) {
  return (
    <div className="ob-win" data-level={w.level}>
      <div className="ob-win__row"><span className="ob-win__label">{w.label}</span><span className="ob-win__pct">{w.pct}%</span></div>
      {/* 条长 = 剩余,越短越紧。 */}
      <div className="ob-win__track"><i style={{ width: `${w.pct}%` }} /></div>
    </div>
  );
}

function Account({ a, icons, colors }: { a: QuotaAccount; icons: Record<string, string>; colors: Record<string, string> }) {
  return (
    <div className="ob-acct" data-stale={a.stale}>
      <div className="ob-acct__head">
        <Mark id={a.id} icons={icons} colors={colors} size={14} />
        <span className="ob-acct__name">{a.name}</span>
        {a.note !== undefined && <span className="ob-acct__note">{a.note}</span>}
      </div>
      {a.windows.length > 0 && <div className="ob-acct__wins">{a.windows.map((w) => <Window key={w.label} w={w} />)}</div>}
      {a.groups?.map((g) => (
        <div className="ob-group" key={g.name}>
          <span className="ob-group__name">{g.name}</span>
          <span className="ob-group__wins">{g.windows.map((w) => <span key={w.label} data-level={w.level}>{w.label} {w.pct}%</span>)}</span>
        </div>
      ))}
      {a.value !== undefined && <div className="ob-acct__value">{a.value}</div>}
      {a.empty !== undefined && <div className="ob-acct__empty">{a.empty}</div>}
    </div>
  );
}

/** 两侧在跑的卡连到球。位置用 offset*(布局坐标,不受外层 scale 影响)量。 */
function Connectors({ host, deps }: { host: RefObject<HTMLDivElement | null>; deps: unknown }) {
  const [paths, setPaths] = useState<string[]>([]);
  useLayoutEffect(() => {
    const root = host.current;
    if (root === null) return;
    const measure = () => {
      const center = root.querySelector<HTMLElement>('.ob-center');
      if (center === null) return;
      const orb = { x: center.offsetLeft + center.offsetWidth / 2, y: center.offsetTop + center.offsetHeight * 0.42 };
      const next: string[] = [];
      root.querySelectorAll<HTMLElement>('.ob-card[data-linked="true"]').forEach((el) => {
        const side = el.closest('.ob-side--left') !== null ? 'left' : 'right';
        next.push(connectorPath({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }, orb, side));
      });
      setPaths((prev) => (prev.join('|') === next.join('|') ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [host, deps]);
  return (
    <svg className="ob-links" aria-hidden="true">
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

export interface OrbitDashboardProps {
  now: NowPlayingText;
  playing: boolean;
  onPlayPause?: () => void;
  cards: readonly OrbitCard[];
  accounts: readonly QuotaAccount[];
  hidden: number;
  sync: { text: string; alert: boolean };
  /** 各家 logo(登记表 id → data:image),壳递进来的;没有就画色点。 */
  icons: Record<string, string>;
  /** 各家主色(登记表的 color)。 */
  colors: Record<string, string>;
  /** 中间的形象位(形象舞台 / 粒子球),由 DisplayApp 给,与第一套同一个。 */
  stage: ReactNode;
  designScale?: number;
  designHeight?: number;
}

export function OrbitDashboard({
  now, playing, onPlayPause, cards, accounts, hidden, sync, icons, colors, stage, designScale = 1, designHeight = 393,
}: OrbitDashboardProps) {
  const middle = useRef<HTMLDivElement>(null);
  const [left, right] = splitSides(cards);
  const dense = accounts.length > DENSE_ACCOUNTS;
  const music = now.sub === '' ? now.title : `${now.title} · ${now.sub}`;
  return (
    <div className="ob-root">
      <div
        className="ob-dash"
        data-dense={dense}
        style={{ height: `${Math.round(designHeight)}px`, transform: `scale(${designScale})` }}
      >
        <header className="ob-top">
          <OrbitClock />
          <div className="ob-music" data-live={now.live}>
            <svg className="ob-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12.5a2 2 0 1 1-1-1.73V3l7-1.5v8.5a2 2 0 1 1-1-1.73V3.7L6 4.8z" /></svg>
            <span className="ob-music__text">{music}</span>
            {onPlayPause !== undefined && (
              <button type="button" className="ob-play" aria-label={playing ? '暂停' : '播放'} onClick={onPlayPause}>
                {playing
                  ? <svg className="ob-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h2.5v10H4zM9.5 3H12v10H9.5z" /></svg>
                  : <svg className="ob-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5 13 8l-8.5 5.5z" /></svg>}
              </button>
            )}
          </div>
        </header>

        <div className="ob-middle" ref={middle}>
          <Connectors host={middle} deps={`${cards.map((c) => `${c.key}${c.linked}`).join(',')}|${dense}|${designHeight}`} />
          <div className="ob-side ob-side--left">{left.map((c) => <SessionCard key={c.key} card={c} icons={icons} colors={colors} />)}</div>
          <div className="ob-center">{stage}</div>
          <div className="ob-side ob-side--right">{right.map((c) => <SessionCard key={c.key} card={c} icons={icons} colors={colors} />)}</div>
        </div>

        <section className="ob-quota">
          <div className="ob-quota__head">
            <span>额度剩余</span>
            <span className="ob-sync" data-alert={sync.alert}>{hidden > 0 ? `另有 ${hidden} 个账号没摆下 · ` : ''}{sync.text}</span>
          </div>
          {accounts.length === 0
            ? <p className="ob-acct__empty">这台电脑上还没有能读额度的那一家</p>
            : (
              <div className="ob-accts" data-count={accounts.length}>
                {accounts.map((a) => <Account key={a.id} a={a} icons={icons} colors={colors} />)}
              </div>
            )}
        </section>
      </div>
    </div>
  );
}
