/**
 * 设置 → 座机 → 「添加座机」(2026-09-22,Ben:「整套流程我希望能在客户端里完成」)。
 *
 * 六步,一步一屏:**找座机 → 选 Wi-Fi → 输密码 → 连 → 配对进房 → 座机已上线**。
 * 用户不去系统设置里切 Wi-Fi、不敲命令、不插线。
 *
 * 这一份只做三件事:把 `provisionMachine` 吐出来的动作交给 `handsetBle` 去做、
 * 把状态画出来、把「配对进房」那一步的两个请求串起来。**一条判断都不许有** ——
 * 判断全在那个 reducer 里,它有用例;这一份没有。
 *
 * ## 「配对进房」那一步到底做了什么
 *
 *   ① 换一把**给座机的**中转设备令牌 —— 手机自己登录过账号就自己领,**没登录就请电脑代办**
 *   (`POST /channel/relay-handset`;2026-09-27 卡 HS,扫码配对的手机按设计没有账号会话)。
 *   两条路都在 handsetLink.ts,那一份有用例 → ② 把它经 BLE 写给座机 →
 *   ③ 座机存进 device.json、重启 phone-bridge → ④ 座机报 `linked: true`。
 *
 * **令牌只在这一个函数里经手**:不进 state、不进日志、不进任何界面文案
 * (同 accountStore.ts 的老规矩)。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSession } from '../session';
import { SubPage } from '../nav/BackHeader';
import { useBackHandler } from '../nav/back';
import { handsetBoundText, issueHandsetToken, type HandsetBoundTo } from './handsetLink';
import { createHandsetBle, HandsetBleError, type HandsetBle } from './handsetBle';
import {
  TEXT, needsPassword, signalBars, type HandsetNetwork,
} from './provisionProtocol';
import {
  START_EFFECTS, initialState, orderedNetworks, retryLabel, step, stepIndex,
  type ProvisionEffect, type ProvisionEvent, type Stepped,
} from './provisionMachine';

/** 扫了这么久还一台都没有就收手。10 秒:比人的耐心短,比一次 BLE 广播间隔长得多。 */
export const SCAN_GIVE_UP_MS = 10_000;

export const ADD_HANDSET_TITLE = '添加座机';
export const ADD_HANDSET_INTRO = '把座机通上电放在手边(一米以内)。它连不上 Wi-Fi 一分钟后会亮出来,这里就找得到了。';

export interface AddHandsetPageProps {
  onClose: () => void;
  /** 测试注入假的那一份。缺省是真的 BLE。 */
  ble?: HandsetBle;
  /** 手机这会儿连着的 Wi-Fi(知道的话),用来把那一个排到列表最前。 */
  phoneSsid?: string;
}

export function AddHandsetPage({ onClose, ble: injected, phoneSsid }: AddHandsetPageProps) {
  const session = useSession();
  const ble = useMemo(() => injected ?? createHandsetBle(), [injected]);
  /**
   * **reducer 的状态就是 `{ 状态, 这一轮要做的动作 }`**(`Stepped`)。
   * 动作不挂在 ref 上:ref 是在 reducer 里写的话 reducer 就不纯了,
   * 而 React 19 的严格模式会把 reducer 跑两遍 —— 那时动作要么做两次要么丢一次。
   * 放进状态里则每一份状态自带它那一轮的动作,下面那个 effect 按状态的身份跑一次。
   */
  const [stepped, dispatch] = useReducer(
    (prev: Stepped, event: ProvisionEvent): Stepped => step(prev.state, event),
    { state: initialState(phoneSsid), effects: START_EFFECTS },
  );
  const state = stepped.state;
  const [psk, setPsk] = useState('');
  const [showPsk, setShowPsk] = useState(false);

  /** 当前连着的那台。动作里要用它的 id,而动作是异步跑的,所以放 ref。 */
  const deviceRef = useRef<string>('');
  /** 座机报上来的 device_id(配对进房那一步要)。 */
  const handsetIdRef = useRef<string>('');
  const handsetNameRef = useRef<string>('');
  /** 座机记到了哪台电脑、哪个账号名下(卡 RM ②)。电脑没回就一直是 undefined,那一行不出。 */
  const boundToRef = useRef<HandsetBoundTo | undefined>(undefined);

  const send = useCallback(async (effect: ProvisionEffect) => {
    try {
      if (effect[0] === 'scan') {
        await ble.scan((devices) => dispatch({ type: 'found', devices }));
        return;
      }
      if (effect[0] === 'stopScan') { await ble.stopScan(); return; }
      if (effect[0] === 'connect') {
        deviceRef.current = effect[1];
        await ble.connect({
          deviceId: effect[1],
          onStatus: (status) => {
            if (status.deviceId !== '') handsetIdRef.current = status.deviceId;
            if (status.name !== '') handsetNameRef.current = status.name;
            dispatch({ type: 'status', status });
          },
          onNetworks: (list) => dispatch({ type: 'networks', list }),
          onLost: () => dispatch({ type: 'lost' }),
        });
        dispatch({ type: 'connected' });
        return;
      }
      if (effect[0] === 'send') { await ble.send(deviceRef.current, effect[1]); return; }
      if (effect[0] === 'disconnect') { await ble.disconnect(deviceRef.current); return; }
      if (effect[0] === 'link') {
        const text = await linkToAccount();
        if (text !== '') dispatch({ type: 'linkFailed', text });
        return;
      }
    } catch (error) {
      const said = error instanceof HandsetBleError ? error.message : '';
      if (effect[0] === 'scan') { dispatch({ type: 'scanFailed', text: said || TEXT.noPermission }); return; }
      if (effect[0] === 'connect') { dispatch({ type: 'connectFailed', text: said || TEXT.connectFailed }); return; }
      if (effect[0] === 'link') { dispatch({ type: 'linkFailed', text: said || TEXT.linkFailed }); return; }
      // send / disconnect 失败等同于断线:座机那头的进度没丢,退回上一步重来。
      dispatch({ type: 'lost' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ble]);

  /** 配对进房那一步。**成了回空串**,没成回一句人话。 */
  const linkToAccount = useCallback(async (): Promise<string> => {
    const name = handsetNameRef.current || '座机话筒';
    /**
     * 两条路(2026-09-27,卡 HS):手机自己登录过账号就自己领;**没登录就请电脑代办** ——
     * 扫码配对进来的手机按设计没有账号会话,以前这一步在它身上必然失败。
     * 判断与文案都在 handsetLink.ts(有用例),这一份只负责把结果交给座机。
     */
    const issued = await issueHandsetToken({
      ...(session.account === undefined ? {} : { store: session.account }),
      ...(session.client === undefined ? {} : { client: session.client }),
      deviceId: handsetIdRef.current,
      name,
    });
    if (!issued.ok) return issued.error;
    // 记到了谁名下(卡 RM ②)。成功那一屏要把它说出来 —— 「记到你的账号下」太含糊,
    // 比赛现场那只座机记到的是另一台电脑的账号,而屏上那句话照样是绿的。
    boundToRef.current = issued.boundTo;
    await ble.send(deviceRef.current, {
      op: 'link',
      relay: issued.relayUrl,
      token: issued.token,
      device_id: handsetIdRef.current,
      name,
    });
    return '';
  }, [session, ble]);

  // 每一份新状态自带它那一轮的动作,在这儿放出去。
  useEffect(() => {
    for (const effect of stepped.effects) void send(effect);
  }, [stepped, send]);

  // 扫了 10 秒还一台都没有就收手。**不无限转圈**:转圈不会变出一台座机来。
  useEffect(() => {
    if (state.step.kind !== 'scanning') return;
    const timer = setTimeout(() => {
      if (state.step.kind === 'scanning' && state.step.found.length === 0) {
        void ble.stopScan();
        dispatch({ type: 'scanEmpty' });
      }
    }, SCAN_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [state.step, ble]);

  // 人半路走了:把扫描与连接都收掉,不留一条后台的 BLE 连接。
  useEffect(() => () => {
    void ble.stopScan();
    if (deviceRef.current !== '') void ble.disconnect(deviceRef.current);
  }, [ble]);

  /**
   * 系统返回键(2026-09-27,卡 SZ2):**这一层自己接**。以前这一页只是设置里的一节,
   * 没人登记这一层,壳那一层判 `page === 'settings'` → 回首页,六步白走。
   * 现在按返回 = 点「‹ 返回」= 回到「座机」那一页。
   */
  useBackHandler(true, onClose);

  const current = state.step;

  return (
    <SubPage title={ADD_HANDSET_TITLE} onBack={onClose}>
      <section className="ba-settings ba-settings__sec">
      <p className="ba-settings__line ba-settings__dim">第 {stepIndex(current)} 步,共 6 步</p>

      {current.kind === 'scanning' && (
        <>
          <p className="ba-settings__line">{TEXT.scanning}</p>
          <p className="ba-settings__line ba-settings__dim">{ADD_HANDSET_INTRO}</p>
          {current.found.map((one) => (
            <button
              key={one.id}
              type="button"
              className="ba-btn ba-btn--ghost"
              onClick={() => dispatch({ type: 'pick', device: one })}
            >{one.name}</button>
          ))}
        </>
      )}

      {current.kind === 'connecting' && <p className="ba-settings__line">{TEXT.connecting}</p>}

      {current.kind === 'networks' && (
        <>
          <p className="ba-settings__line">选一个 Wi-Fi 给座机连</p>
          <p className="ba-settings__line ba-settings__dim">座机只认 2.4G 的网,5G 的它看不见 —— 列表里没有的那个多半就是 5G。</p>
          {current.busy && <p className="ba-settings__line ba-settings__dim">{TEXT.wifiScanning}</p>}
          {!current.busy && current.list.length === 0 && <p className="ba-settings__line">{TEXT.wifiEmpty}</p>}
          {orderedNetworks(state).map((one) => (
            <button
              key={one.ssid}
              type="button"
              className="ba-btn ba-btn--ghost"
              onClick={() => { setPsk(''); setShowPsk(false); dispatch({ type: 'choose', network: one }); }}
            >{networkLine(one)}</button>
          ))}
          <div className="ba-row">
            <button type="button" className="ba-btn ba-btn--ghost" disabled={current.busy}
              onClick={() => dispatch({ type: 'rescan' })}>重新找一遍</button>
          </div>
        </>
      )}

      {current.kind === 'password' && (
        <>
          <p className="ba-settings__line">{current.network.ssid} 的密码</p>
          {current.network.saved && (
            <p className="ba-settings__line ba-settings__dim">座机以前连过这个网。直接点「连接」试试,不行再输一遍密码。</p>
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
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'submit', psk })}>连接</button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={() => dispatch({ type: 'back' })}>换一个</button>
          </div>
        </>
      )}

      {(current.kind === 'joining' || current.kind === 'linking') && (
        <p className="ba-settings__line">{current.text}</p>
      )}

      {current.kind === 'done' && (
        <>
          <p className="ba-settings__line">{TEXT.done}</p>
          <p className="ba-settings__line ba-settings__dim">
            它连着 {current.ssid}。{handsetBoundText(boundToRef.current) ?? '已经记到你的账号下。'}
            往后它自己会进房,事务官打电话来时它会响。
          </p>
          <div className="ba-row">
            <button type="button" className="ba-btn" onClick={onClose}>好了</button>
          </div>
        </>
      )}

      {current.kind === 'failed' && (
        <>
          <p className="ba-settings__line">{current.text}</p>
          <div className="ba-row">
            {/*
              卡在系统定位那个开关上时多一颗键(2026-09-27,卡 RM ③)。
              **只在这一种失败上出**,而且插件支持得了才出(iOS 没这条规矩)。
            */}
            {current.text === TEXT.locationOff && ble.openLocationSettings !== undefined && (
              <button type="button" className="ba-btn" onClick={() => { void ble.openLocationSettings?.(); }}>
                去打开位置信息
              </button>
            )}
            <button type="button" className="ba-btn" onClick={() => dispatch({ type: 'retry' })}>
              {retryLabel(current.at)}
            </button>
            <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>先不弄了</button>
          </div>
        </>
      )}

      {current.kind !== 'done' && current.kind !== 'failed' && (
        <div className="ba-row">
          <button type="button" className="ba-btn ba-btn--ghost" onClick={onClose}>先不弄了</button>
        </div>
      )}
      </section>
    </SubPage>
  );
}

/** 一行 Wi-Fi 长什么样。**不显示 dBm,也不显示加密算法的名字** —— 没人看得懂。 */
export function networkLine(one: HandsetNetwork): string {
  const bars = '▂▄▆█'.slice(0, signalBars(one.signal));
  const marks = [
    one.inUse ? '座机连着' : '',
    one.saved && !one.inUse ? '连过' : '',
    needsPassword(one) ? '' : '不要密码',
  ].filter((t) => t !== '');
  return `${one.ssid}  ${bars}${marks.length === 0 ? '' : `  · ${marks.join(' · ')}`}`;
}
