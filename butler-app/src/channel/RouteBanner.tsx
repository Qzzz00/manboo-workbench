/**
 * 在家 / 出门要她看一眼的那两句(2026-10-21,局域网 M4),压在首页顶上:
 *
 *   1. **「这是你常用的网络吗」**:没确认过的 Wi-Fi 上 mDNS 看到了配对过的那台电脑,问一次(规格第二节第 2 条)。
 *      答「是」:这个网络上电话和说话走家里那条(本机房间,不经云);答「不是」:记下来,这个网络上不再问。
 *   2. **「换了网络,这一通断了,点一下回拨」**:通话中走出家门、换到云房间,这一通续不上(续上是卡 M9)。
 *
 * 切换本身不打扰(Ben 09-17 的口径:切换是自动的,别弹窗)—— 只有要她答的、和断了一通这两样才出来。
 */
import { useEffect, useState } from 'react';
import type { PhoneRoute } from './phoneRoute';
import { ROUTE_TITLE_TEXT, routeReasonText, type RouteView } from './routeDriver';
import { WBCH_CALL_ROUTE_DROPPED_TEXT } from './channel';

/** 路线驱动此刻那一份(订阅着,变了就重画)。没有路线(网页里、老会话)是 null。 */
export function useRouteView(route: Pick<PhoneRoute, 'driver'> | undefined): RouteView | null {
  const [view, setView] = useState<RouteView | null>(() => route?.driver.view() ?? null);
  useEffect(() => {
    if (route === undefined) { setView(null); return; }
    setView(route.driver.view());
    return route.driver.subscribe(() => setView(route.driver.view()));
  }, [route]);
  return view;
}

/** 断了一通之后那句话挂多久(毫秒):过了就不再提醒回拨。 */
export const ROUTE_DROPPED_SHOW_MS = 2 * 60_000;

export function RouteBanner({ route, onCallBack, now = () => Date.now() }: {
  route: Pick<PhoneRoute, 'driver' | 'onCallDropped'>;
  /** 「回拨」:回首页开一通。 */
  onCallBack(): void;
  now?: () => number;
}) {
  const view = useRouteView(route);
  const [droppedAt, setDroppedAt] = useState<number | null>(null);
  useEffect(() => route.onCallDropped(() => setDroppedAt(now())), [route, now]);
  useEffect(() => {
    if (droppedAt === null) return;
    const timer = setTimeout(() => setDroppedAt(null), ROUTE_DROPPED_SHOW_MS);
    return () => clearTimeout(timer);
  }, [droppedAt]);

  const asking = view?.asking ?? null;
  if (asking === null && droppedAt === null) return null;
  return (
    <div className="ba-route-banner">
      {droppedAt !== null && (
        <div className="ba-notice ba-route-banner__row" role="status">
          <span>{WBCH_CALL_ROUTE_DROPPED_TEXT}</span>
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => { setDroppedAt(null); onCallBack(); }}>回拨</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => setDroppedAt(null)}>知道了</button>
          </div>
        </div>
      )}
      {asking !== null && (
        <div className="ba-notice ba-route-banner__row" role="dialog" aria-label="这是你常用的网络吗">
          <span>
            这个网络{asking.label === undefined ? '' : `(${asking.label})`}里找到了你的电脑{asking.mac_name === undefined ? '' : `「${asking.mac_name}」`}。
            这是你家里或办公室常用的网络吗?
          </span>
          <span className="ba-settings__dim">是的话,在这个网络上电话和说话直接连这台电脑,不经云;不是就按出门走。</span>
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => route.driver.answerHomeNetwork(true)}>是,常用网络</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => route.driver.answerHomeNetwork(false)}>不是</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 设置 → 我的电脑 里那一节:此刻在家 / 出门 / 没连上,原因一行;这个网络是不是常用的,她自己也能说。 */
export function RouteSection({ route }: { route: Pick<PhoneRoute, 'driver'> }) {
  const view = useRouteView(route);
  if (view === null) return null;
  return <RouteSectionBody view={view} onMark={(yes) => route.driver.markNetwork(yes)} />;
}

export function RouteSectionBody({ view, onMark }: { view: RouteView; onMark(yes: boolean): void }) {
  const lanNet = (view.network.kind === 'wifi' || view.network.kind === 'ethernet') && view.network.id !== null && !view.revoked;
  return (
    <section className="ba-settings__sec" data-route={view.route}>
      <h2 className="ba-inbox__h">在家 / 出门</h2>
      <p className="ba-settings__line">此刻:{view.deciding && view.route === 'none' ? '正在判断' : ROUTE_TITLE_TEXT[view.route]}</p>
      <p className="ba-settings__line ba-settings__dim">{routeReasonText(view)}</p>
      {lanNet && !view.trusted && (
        <div className="ba-row">
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => onMark(true)}>这是我常用的网络</button>
        </div>
      )}
      {lanNet && view.trusted && (
        <div className="ba-row">
          <button type="button" className="ba-btn ba-btn--ghost" onClick={() => onMark(false)}>这个网络不再算常用</button>
        </div>
      )}
      <p className="ba-settings__line ba-settings__dim">
        在家:电话、说话、看板都直接连这台电脑(本机房间),不经云。出门:走云上那间房,由电脑上的事务官代办。
        只有你确认过的网络才算「在家」;别的 Wi-Fi(公司、咖啡馆)即使连得上电脑也按出门走。
      </p>
    </section>
  );
}
