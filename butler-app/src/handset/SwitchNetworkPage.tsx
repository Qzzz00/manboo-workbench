/**
 * 设置 → 座机 → 「给座机换网络」(2026-09-22 晚)。
 *
 * 四步:**看到座机 → 选 Wi-Fi → 输密码 → 等它切过去回来**。
 * 走的是**房间**那条现成的链路(不是蓝牙),所以人不必靠近座机,也不用蓝牙权限。
 * 两条路的分工见 `switchNetwork.ts` 的文件头。
 *
 * 这一份只做三件事:把 `switchStep` 吐出来的动作发出去、把座机的回话喂回去、
 * 把状态画出来。**一条判断都不许有** —— 判断全在那个 reducer 里,它有用例。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSession } from '../session';
import { SubPage } from '../nav/BackHeader';
import { useBackHandler } from '../nav/back';
import { fetchWbchDevices } from '../channel/devices';
import { needsPassword, type HandsetNetwork } from './provisionProtocol';
import { networkLine } from './AddHandsetPage';
import {
  NETCFG_TOPIC, NO_HANDSET_TEXT, SCAN_TIMEOUT_MS, SEND_FAILED_TEXT, SWITCHING_NOTE,
  SWITCH_TIMEOUT_MS, SWITCH_TITLE, doneText, initialSwitchState, orderedSwitchNetworks,
  parseNetcfgReply, scanRequest, switchRequest, switchStep,
  type SwitchEffect, type SwitchEvent, type SwitchStepped,
} from './switchNetwork';

export const SWITCH_NETWORK_LABEL = '给座机换网络';
export const SWITCH_NETWORK_HINT = '座机已经在线的时候用这个(比如出门前先把现场的网配好)。走的是它和电脑之间那条现成的通道,不用蓝牙、不用靠近它。';

/** 多久问一次「座机在不在线」。5 秒:换网期间它会离线一阵,这一行状态要跟得上。 */
export const HANDSET_POLL_MS = 5_000;

export interface SwitchNetworkPageProps {
  onClose: () => void;
  /** 手机这会儿连着的 Wi-Fi(知道的话)。 */
  phoneSsid?: string;
}

export function SwitchNetworkPage({ onClose, phoneSsid }: SwitchNetworkPageProps) {
  const session = useSession();
  const [stepped, dispatch] = useReducer(
    (prev: SwitchStepped, event: SwitchEvent): SwitchStepped => switchStep(prev.state, event),
    { state: initialSwitchState(phoneSsid), effects: [] },
  );
  const state = stepped.state;
  const [psk, setPsk] = useState('');
  const [showPsk, setShowPsk] = useState(false);
  /** 这一条请求的 id。**回话按它对号** —— 那条 topic 上还跑着来电与字幕。 */
  const askingRef = useRef<string>('');
  const handsetRef = useRef<string>('');
  const [handsetName, setHandsetName] = useState('');

  /** 往座机发一条。**点名发** —— 那条消息里有 Wi-Fi 密码。 */
  const ask = useCallback(async (body: string): Promise<string> => {
    const to = handsetRef.current;
    if (to === '') return NO_HANDSET_TEXT;
    try {
      const credential = session.channel.credential();
      if (credential === null) {
        const got = await session.channel.refresh();
        if (!got.ok) return got.error;
      }
      const cred = session.channel.credential();
      if (cred === null) return SEND_FAILED_TEXT;
      await session.channel.link.acquire('netcfg', cred);
      await session.channel.link.sendText(body, NETCFG_TOPIC, to);
      return '';
    } catch (error) {
      return error instanceof Error && error.message !== '' ? error.message : SEND_FAILED_TEXT;
    }
  }, [session]);

  const run = useCallback(async (effect: SwitchEffect) => {
    if (effect[0] === 'done') {
      await session.channel.link.release('netcfg');
      return;
    }
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    askingRef.current = id;
    const body = effect[0] === 'scan' ? scanRequest(id) : switchRequest(id, effect[1], effect[2]);
    const said = await ask(body);
    if (said !== '') dispatch({ type: 'sendFailed', text: said });
  }, [ask, session]);

  useEffect(() => {
    for (const effect of stepped.effects) void run(effect);
  }, [stepped, run]);

  // ——— 座机在不在线(工人那份「在线设备」) ———
  useEffect(() => {
    let alive = true;
    const look = async () => {
      const self = session.channel.credential()?.identity ?? null;
      const got = await fetchWbchDevices(session.client, self, { kinds: ['handset'] });
      if (!alive) return;
      const one = got.devices[0];
      if (one === undefined) { dispatch({ type: 'noHandset' }); return; }
      handsetRef.current = one.identity;
      setHandsetName(one.name);
      dispatch({ type: 'handset', identity: one.identity, name: one.name });
    };
    void look();
    const timer = setInterval(() => { void look(); }, HANDSET_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [session]);

  // ——— 座机的回话 ———
  useEffect(() => session.channel.link.listen({
    onText: (text) => {
      const reply = parseNetcfgReply(text);
      // **按 id 对号**:这条 topic 上还跑着来电、字幕、缓冲语和工人的应答。
      if (reply === null || reply.id !== askingRef.current) return;
      dispatch({ type: 'reply', reply });
    },
  }), [session]);

  // ——— 等太久 ———
  useEffect(() => {
    const kind = state.step.kind;
    if (kind !== 'scanning' && kind !== 'switching') return;
    const wait = kind === 'switching' ? SWITCH_TIMEOUT_MS : SCAN_TIMEOUT_MS;
    const timer = setTimeout(() => dispatch({ type: 'timeout' }), wait);
    return () => clearTimeout(timer);
  }, [state.step]);

  // 人半路走了:把房间那一份持有放掉(座机模式那一份是另一个 holder,不受影响)。
  useEffect(() => () => { void session.channel.link.release('netcfg'); }, [session]);

  /** 系统返回键(2026-09-27,卡 SZ2):这一层自己接 —— 回到「座机」那一页,不弹回首页。 */
  useBackHandler(true, onClose);

  const current = state.step;

  return (
    <SubPage title={SWITCH_NETWORK_LABEL} onBack={onClose}>
      <section className="ba-settings ba-settings__sec">
      <p className="ba-settings__line ba-settings__dim">{SWITCH_TITLE[current.kind]}</p>

      {current.kind === 'offline' && (
        <>
          <p className="ba-settings__line">{NO_HANDSET_TEXT}</p>
          <div className="ba-row">
            <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>回去</button>
          </div>
        </>
      )}

      {current.kind === 'scanning' && (
        <p className="ba-settings__line">正在让{handsetName || '座机'}扫一遍附近的 Wi-Fi…</p>
      )}

      {current.kind === 'networks' && (
        <>
          <p className="ba-settings__line">换到哪个网</p>
          <p className="ba-settings__line ba-settings__dim">座机只认 2.4G 的网,5G 的它看不见。</p>
          {current.busy && <p className="ba-settings__line ba-settings__dim">正在扫…</p>}
          {!current.busy && current.list.length === 0 && (
            <p className="ba-settings__line">座机一个 Wi-Fi 都没扫到。它离路由器太远了。</p>
          )}
          {orderedSwitchNetworks(state).map((one: HandsetNetwork) => (
            <button
              key={one.ssid}
              type="button"
              className="ba-btn ba-btn--ghost"
              onClick={() => { setPsk(''); setShowPsk(false); dispatch({ type: 'choose', network: one }); }}
            >{networkLine(one)}</button>
          ))}
          <div className="ba-row">
            <button type="button" className="ba-btn ba-btn--ghost" disabled={current.busy}
              onClick={() => dispatch({ type: 'rescan' })}>重新扫一遍</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>先不弄了</button>
          </div>
        </>
      )}

      {current.kind === 'password' && (
        <>
          <p className="ba-settings__line">{current.network.ssid} 的密码</p>
          {current.network.inUse && (
            <p className="ba-settings__line ba-settings__dim">座机现在连的就是这个网 —— 不用换。</p>
          )}
          {current.network.saved && !current.network.inUse && (
            <p className="ba-settings__line ba-settings__dim">座机以前连过这个网。直接点「换过去」试试。</p>
          )}
          {!needsPassword(current.network) && (
            <p className="ba-settings__line ba-settings__dim">这个网不要密码,直接点「换过去」。</p>
          )}
          <label className="ba-field">
            <input
              className="ba-input"
              type={showPsk ? 'text' : 'password'}
              aria-label="Wi-Fi 密码"
              value={psk}
              autoComplete="off"
              onChange={(e) => setPsk(e.target.value)}
            />
          </label>
          <label className="ba-switch">
            <input type="checkbox" checked={showPsk} onChange={(e) => setShowPsk(e.target.checked)} />
            <span>显示密码</span>
          </label>
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'submit', psk })}>换过去</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'back' })}>换一个</button>
          </div>
        </>
      )}

      {current.kind === 'switching' && (
        <>
          <p className="ba-settings__line">正在把座机换到 {current.ssid}…</p>
          <p className="ba-settings__line ba-settings__dim">{SWITCHING_NOTE}</p>
        </>
      )}

      {current.kind === 'done' && (
        <>
          <p className="ba-settings__line">{doneText(current.ssid, current.ip)}</p>
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={onClose}>好了</button>
          </div>
        </>
      )}

      {current.kind === 'failed' && (
        <>
          <p className="ba-settings__line">{current.text}</p>
          {current.rolledBack && (
            <p className="ba-settings__line ba-settings__dim">座机还在原来的网上,电话照样接得到。</p>
          )}
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'retry' })}>再试一次</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>先不弄了</button>
          </div>
        </>
      )}
      </section>
    </SubPage>
  );
}
