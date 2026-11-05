/**
 * 配对页(2026-09-16 起以扫码为主)。状态机在 pairingMachine.ts,这里只投影 + 接副作用(mDNS、扫码、claim)。
 *
 * 首屏:大按钮「扫码登录」;局域网发现在后台跑,找到的以小列表放在按钮下方(点它要输 6 位码——这条路的安全所在)。
 * 扫到 workbench://pair?…&code 直接 claim,成功进主页,全程不输字;相机拒绝 / 打不开才在同屏给「手输 6 位码」。
 *
 * 2026-09-17:这一页成了登录流程的第三屏(login/LoginPage.tsx),所以多了四样小东西——
 * 文案改成登录语气、`autoScan`(从指引屏一键进来直接开相机)、`onBack`(回欢迎屏)、
 * 以及配对成功时把 mDNS 里见过的工作台名字一起交出去(顶上要显示「已登录:工作台 · xxx」)。
 * **配对本身一个字没改**:scanned → claiming 那条路还是原来那条。
 */
import { useCallback, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { initialPairing, reducePairing, type DiscoveredWorkbench, type PairingState, type Target } from './pairingMachine';
import { startDiscovery } from './discovery';
import { claimPairing } from './claim';
import { parsePairUrl, type PairTarget } from './pairUrl';
import type { Pairing } from '../api/tokenStore';
import { QrScanner, type QrScannerProps } from './QrScanner';

const DISCOVERY_TIMEOUT_MS = 8000;
const NOT_PAIR_QR = '这不是工作台的配对二维码';

export interface PairPageProps {
  onPaired(pairing: Pairing): void;
  /** 深链带进来的目标(冷启动或运行中收到 workbench://pair?…)。 */
  incoming?: PairTarget | null;
  /** 为什么回到这一页(令牌失效等),显示在顶部。 */
  notice?: string | null;
  deviceName?: string;
  /** 一进来就开相机(登录指引屏上点「去扫码」)。 */
  autoScan?: boolean;
  /** 首屏多一颗「返回」(回登录欢迎屏)。不给就没有这颗键。 */
  onBack?: () => void;
  /** 局域网里发现了一台工作台(上层拿去点那盏「电脑」灯)。 */
  onDiscovered?: (workbench: DiscoveredWorkbench) => void;
  /** 进这一页之前已经发现过的(登录前两屏找到的),直接带进列表。 */
  seen?: readonly DiscoveredWorkbench[];
  /** 测试注入。 */
  discover?: typeof startDiscovery;
  claim?: typeof claimPairing;
  scanner?: ComponentType<QrScannerProps>;
}

export function PairPage({
  onPaired, incoming = null, notice = null, deviceName = '我的手机',
  autoScan = false, onBack, onDiscovered, seen,
  discover = startDiscovery, claim = claimPairing, scanner: Scanner = QrScanner,
}: PairPageProps) {
  // 初值里就把「登录前两屏已经找到的」和「一进来就开相机」办了:放 effect 里会先闪一眼首屏。
  const [state, dispatch] = useReducer(reducePairing, undefined, () => {
    let start = (seen ?? []).reduce<PairingState>((s, workbench) => reducePairing(s, { type: 'discovered', workbench }), initialPairing());
    if (autoScan) start = reducePairing(start, { type: 'scan_start' });
    return start;
  });
  const [code, setCode] = useState('');
  const [manual, setManual] = useState('');
  const [name, setName] = useState(deviceName);
  const claimingRef = useRef(false);

  // 发现:后台跑,不管当前在哪一屏;结果只往列表里记。「重新找」(rediscover)会重跑。
  const discoveryRun = state.phase === 'discovering' && !state.done;
  useEffect(() => {
    if (!discoveryRun) return;
    let stopped = false;
    let handle: { stop(): Promise<void> } | null = null;
    void discover({
      onFound: (workbench) => { if (!stopped) { dispatch({ type: 'discovered', workbench }); onDiscovered?.(workbench); } },
      onUnavailable: () => { if (!stopped) dispatch({ type: 'discovery_unavailable' }); },
    }).then((h) => { handle = h; if (stopped) void h.stop(); });
    const timer = setTimeout(() => { if (!stopped) dispatch({ type: 'discovery_done' }); }, DISCOVERY_TIMEOUT_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      void handle?.stop();
    };
  }, [discoveryRun, discover, onDiscovered]);

  // 深链
  useEffect(() => {
    if (incoming !== null) dispatch({ type: 'scanned', target: incoming });
  }, [incoming]);

  // claim
  useEffect(() => {
    if (state.phase !== 'claiming' || claimingRef.current) return;
    claimingRef.current = true;
    const { target, code: submitted } = state;
    void claim({ target, code: submitted, deviceName: name.trim() === '' ? deviceName : name.trim() }).then((result) => {
      claimingRef.current = false;
      if (result.ok) {
        // 局域网里见过这一台就把它的名字一起记下来(mDNS 广播的 `工作台 · <主机名>`),
        // 之后设置页显示「已登录:工作台 · xxx」;扫码进来又没广播时就没有,界面退回显示地址。
        const known = state.found.find((w) => w.host === target.host && w.port === target.port);
        const paired: Pairing = known === undefined ? result.pairing : { ...result.pairing, workbenchName: known.name };
        dispatch({ type: 'claim_ok', pairing: paired });
        onPaired(paired);
      } else {
        dispatch({ type: 'claim_failed', error: result.error, ...(result.lockedUntil === undefined ? {} : { lockedUntil: result.lockedUntil }) });
      }
    });
  }, [state, claim, name, deviceName, onPaired]);

  const onScanned = useCallback((text: string) => {
    const target = parsePairUrl(text);
    if (target === null) {
      dispatch({ type: 'scan_failed', error: NOT_PAIR_QR });
      return;
    }
    dispatch({ type: 'scanned', target });
  }, []);
  const onScanCancel = useCallback(() => dispatch({ type: 'scan_cancel' }), []);
  const onScanError = useCallback((message: string) => dispatch({ type: 'scan_failed', error: message }), []);

  if (state.phase === 'scanning' && state.error === undefined) {
    return <Scanner onResult={onScanned} onCancel={onScanCancel} onError={onScanError} />;
  }

  const pick = (target: Target) => dispatch({ type: 'pick', target });

  return (
    <div className="ba-pair">
      <header className="ba-pair__head">
        <h1 className="ba-pair__title">事务官</h1>
        <p className="ba-pair__sub">扫电脑上的配对码登录</p>
        {notice !== null && <p className="ba-notice" role="status">{notice}</p>}
      </header>

      {state.phase === 'discovering' && (
        <section className="ba-pair__body">
          <button type="button" className="ba-btn ba-btn--big" onClick={() => dispatch({ type: 'scan_start' })}>扫码登录</button>
          <p className="ba-pair__hint">在电脑的工作台设置 → 手机与设备里点「生成二维码」,用这里扫它。</p>
          <FoundList found={state.found} onPick={pick} />
          <button type="button" className="ba-btn ba-btn--ghost ba-pair__alt" onClick={() => dispatch({ type: 'manual' })}>扫不了?手输地址和 6 位码</button>
          {onBack !== undefined && <button type="button" className="ba-btn ba-btn--ghost ba-pair__alt" onClick={onBack}>返回</button>}
        </section>
      )}

      {state.phase === 'scanning' && state.error !== undefined && (
        <section className="ba-pair__body">
          <p className="ba-error" role="alert">{state.error}</p>
          <p className="ba-pair__step">
            {state.found.length > 0 ? '扫不了才用这个:先选工作台,再输 6 位码。' : '扫不了才用这个:手输工作台地址,再输 6 位码。'}
          </p>
          <FoundList found={state.found} onPick={pick} />
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'manual' })}>手输地址</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'scan_start' })}>再试一次扫码</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'scan_cancel' })}>取消</button>
          </div>
        </section>
      )}

      {state.phase === 'manual' && (
        <section className="ba-pair__body">
          <p className="ba-pair__step">扫不了才用这个:填工作台地址,下一步输 6 位码。</p>
          <FoundList found={state.found} onPick={pick} />
          <label className="ba-field">
            <span>工作台地址</span>
            <input className="ba-input" inputMode="url" placeholder="192.168.1.8:8791" value={manual} onChange={(e) => setManual(e.target.value)} />
          </label>
          {state.error !== undefined && <p className="ba-error" role="alert">{state.error}</p>}
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'manual_target', raw: manual })}>下一步</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'scan_start' })}>重新扫码</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'back' })}>返回</button>
          </div>
        </section>
      )}

      {(state.phase === 'code' || state.phase === 'claiming') && (
        <section className="ba-pair__body">
          <p className="ba-pair__step">工作台 {state.target.host}:{state.target.port}</p>
          <p className="ba-pair__hint">在电脑的工作台设置 → 手机与设备里点「生成二维码」,把二维码下面那 6 位数字填在这里(5 分钟内有效)。</p>
          <label className="ba-field">
            <span>配对码</span>
            <input
              className="ba-input ba-input--code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={state.phase === 'claiming'}
            />
          </label>
          <label className="ba-field">
            <span>这台手机叫什么(工作台里显示)</span>
            <input className="ba-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </label>
          {state.phase === 'code' && state.error !== undefined && <p className="ba-error" role="alert">{state.error}</p>}
          <div className="ba-row">
            <button type="button" className="ba-btn" disabled={state.phase === 'claiming'} onClick={() => dispatch({ type: 'submit', code })}>
              {state.phase === 'claiming' ? '配对中…' : '配对'}
            </button>
            <button type="button" className="ba-btn ba-btn--ghost" disabled={state.phase === 'claiming'} onClick={() => dispatch({ type: 'scan_start' })}>重新扫码</button>
            <button type="button" className="ba-btn ba-btn--ghost" disabled={state.phase === 'claiming'} onClick={() => dispatch({ type: 'back' })}>返回</button>
          </div>
        </section>
      )}

      {state.phase === 'paired' && (
        <section className="ba-pair__body"><p className="ba-pair__step">配对成功</p></section>
      )}
    </div>
  );
}

/** 局域网里找到的工作台。没找到就整块不显示、不弹说明(Ben 2026-09-16)。 */
function FoundList({ found, onPick }: { found: DiscoveredWorkbench[]; onPick(target: Target): void }) {
  if (found.length === 0) return null;
  return (
    <div className="ba-pair__found">
      <p className="ba-pair__step">局域网里找到的工作台</p>
      <ul className="ba-list">
        {found.map((w) => (
          <li key={`${w.host}:${w.port}`}>
            <button type="button" className="ba-card ba-card--tap" onClick={() => onPick({ host: w.host, port: w.port })}>
              <span className="ba-card__title">{w.name}</span>
              <span className="ba-card__meta">{w.host}:{w.port}{w.version === undefined ? '' : ` · ${w.version}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type { PairingState };
