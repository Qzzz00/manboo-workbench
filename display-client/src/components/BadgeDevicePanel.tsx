/* 吧唧设备连接区块（并入工坊面板顶部）。三态：未连接→扫描选设备 / 连接中 / 已连接控制。
 * 连接=可选增强：不影响工坊烘焙上传。连接状态页面级——组件卸载即 disconnect。
 * 单设备：localStorage 记住 MAC，进面板自动重连。deviceId 对齐经 onConnectedMac 上抛。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  scan, stopScan, connect, disconnect, connectedDeviceId,
  setBrightness, setScreen, setVolume, setWifi,
  type ScanHit, type BadgeState,
} from '../lib/badgeBle.ts';
import './badgeDevicePanel.css';

const LS_KEY = 'aiboo:badge-device'; // { bleDeviceId, name, mac }

type Phase = 'idle' | 'scanning' | 'connecting' | 'connected';

export function BadgeDevicePanel({ onConnectedMac }: { onConnectedMac: (mac: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [hits, setHits] = useState<ScanHit[]>([]);
  const [state, setState] = useState<BadgeState | null>(null);
  const [error, setError] = useState<string>('');
  const scanTimer = useRef<number | null>(null);
  // 滑条节流：拖动时本地即时反馈(dragVal)，BLE 发送限速 120ms/次(防积压卡顿)，松手发终值
  const [dragVal, setDragVal] = useState<{ bri?: number; vol?: number }>({});
  // WiFi 配网：输完即发，密码不落 state 存储
  const [ssid, setSsid] = useState('');
  const [pwd, setPwd] = useState('');
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiMsg, setWifiMsg] = useState('');
  const throttleRef = useRef<{ bri: number; vol: number }>({ bri: 0, vol: 0 });
  const sendThrottled = useCallback((kind: 'bri' | 'vol', v: number) => {
    const now = Date.now();
    if (now - throttleRef.current[kind] >= 120) {
      throttleRef.current[kind] = now;
      void (kind === 'bri' ? setBrightness(v) : setVolume(v));
    }
  }, []);

  const onDisconnect = useCallback(() => {
    setPhase('idle');
    setState(null);
    setWifiBusy(false); // 配网触发重启会断连，复位忙态
    onConnectedMac(null);
  }, [onConnectedMac]);

  // 重连后 STAT 回报 WiFi 已连 → 清掉配网过程中的旧提示（如假 timeout）
  useEffect(() => {
    if (state?.wifiConnected) {
      setWifiMsg('WiFi 已连接 ✓');
      setWifiBusy(false);
    }
  }, [state?.wifiConnected]);

  const doConnect = useCallback(async (bleDeviceId: string, name: string) => {
    setError('');
    setPhase('connecting');
    await stopScan();
    try {
      await connect(bleDeviceId, (s) => {
        setState(s);
        onConnectedMac(s.mac);
      }, onDisconnect);
      setPhase('connected');
      localStorage.setItem(LS_KEY, JSON.stringify({ bleDeviceId, name }));
    } catch (e) {
      setError(`连接失败：${e instanceof Error ? e.message : String(e)}`);
      setPhase('idle');
    }
  }, [onConnectedMac, onDisconnect]);

  const startScan = useCallback(async () => {
    setError('');
    setHits([]);
    setPhase('scanning');
    const seen = new Set<string>();
    try {
      await scan((h) => {
        if (seen.has(h.deviceId)) return;
        seen.add(h.deviceId);
        setHits((prev) => [...prev, h]);
      });
      // 10s 超时停扫
      scanTimer.current = window.setTimeout(async () => {
        await stopScan();
        setPhase((p) => (p === 'scanning' ? 'idle' : p));
        setHits((prev) => { if (prev.length === 0) setError('没找到吧唧：先看它屏幕亮没亮——按一下吧唧的 PWR 键亮屏再扫；若它正被其他手机连着，先断开那边'); return prev; });
      }, 10000);
    } catch (e) {
      setError(`扫描失败（蓝牙权限？）：${e instanceof Error ? e.message : String(e)}`);
      setPhase('idle');
    }
  }, []);

  // 进面板：若有记录的设备，自动重连（后台，不弹列表）
  useEffect(() => {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      try {
        const { bleDeviceId, name } = JSON.parse(raw) as { bleDeviceId: string; name: string };
        if (bleDeviceId) void doConnect(bleDeviceId, name);
      } catch { /* 记录损坏，忽略 */ }
    }
    return () => {
      if (scanTimer.current) window.clearTimeout(scanTimer.current);
      void stopScan();
      if (connectedDeviceId()) void disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const briPct = state ? Math.round((state.brightness / 255) * 100) : 0;

  const onConnectWifi = async () => {
    if (!ssid || wifiBusy) return;
    setWifiBusy(true);
    setWifiMsg('已下发，吧唧将重启并连接 WiFi（约 15 秒，需重新连接蓝牙查看结果）…');
    try {
      await setWifi(ssid, pwd);
      setPwd('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 吧唧收到配网帧后会重启，BLE 写回执常来不及送达 → timeout 是预期路径，不是失败
      if (/timeout/i.test(msg)) {
        setPwd('');
        setWifiMsg('已下发，吧唧重启连接中（约 15 秒后重新连接蓝牙查看结果）…');
      } else {
        setWifiMsg(`下发失败：${msg}`);
        setWifiBusy(false);
      }
    }
  };

  return (
    <div className="badge-dev">
      {phase === 'idle' && (
        <>
          <button type="button" className="badge-dev__connect" onClick={startScan}>🔗 连接吧唧</button>
          {error && <p className="badge-dev__err">{error}</p>}
        </>
      )}

      {phase === 'scanning' && (
        <div className="badge-dev__scan">
          <p className="badge-dev__hint">扫描中…（找 Aiboo-XXXX）</p>
          {hits.map((h) => (
            <button key={h.deviceId} type="button" className="badge-dev__hit" onClick={() => doConnect(h.deviceId, h.name)}>
              <span>{h.name}</span><span className="badge-dev__rssi">{h.rssi} dBm</span>
            </button>
          ))}
        </div>
      )}

      {phase === 'connecting' && <p className="badge-dev__hint">连接中…</p>}

      {phase === 'connected' && state && (
        <div className="badge-dev__ctrl">
          <div className="badge-dev__row badge-dev__title">
            <span>已连接 · {state.mac}</span>
            <button type="button" className="badge-dev__disc" onClick={() => void disconnect()}>断开</button>
          </div>
          {state.battery != null && (
            <div className="badge-dev__row">
              <span>🔋 电量</span>
              <span className="badge-dev__batt">{state.battery}%</span>
            </div>
          )}
          <label className="badge-dev__row">
            <span>亮度 {dragVal.bri ?? briPct}%</span>
            <input type="range" min={0} max={100} value={dragVal.bri ?? briPct}
              onChange={(e) => { const v = Number(e.target.value); setDragVal((d) => ({ ...d, bri: v })); sendThrottled('bri', v); }}
              onPointerUp={(e) => { const v = Number((e.target as HTMLInputElement).value); void setBrightness(v); setDragVal((d) => ({ ...d, bri: undefined })); }} />
          </label>
          <label className="badge-dev__row">
            <span>屏幕</span>
            <input type="checkbox" checked={state.screenOn}
              onChange={(e) => void setScreen(e.target.checked)} />
          </label>
          <label className="badge-dev__row">
            <span>音量 {dragVal.vol ?? state.volume}</span>
            <input type="range" min={0} max={100} value={dragVal.vol ?? state.volume}
              onChange={(e) => { const v = Number(e.target.value); setDragVal((d) => ({ ...d, vol: v })); sendThrottled('vol', v); }}
              onPointerUp={(e) => { const v = Number((e.target as HTMLInputElement).value); void setVolume(v); setDragVal((d) => ({ ...d, vol: undefined })); }} />
          </label>
          <div className="badge-dev__wifi">
            <div className="badge-dev__row badge-dev__title">
              <span>📶 WiFi</span>
              <span className={state.wifiConnected ? 'badge-dev__wifi-on' : 'badge-dev__wifi-off'}>
                {state.wifiConnected ? '已连接 ✓' : '未连接'}
              </span>
            </div>
            <input className="badge-dev__wifi-input" placeholder="WiFi 名称（仅 2.4GHz）"
              value={ssid} maxLength={32} onChange={(e) => setSsid(e.target.value)} />
            <input className="badge-dev__wifi-input" type="password" placeholder="密码"
              value={pwd} maxLength={63} onChange={(e) => setPwd(e.target.value)} />
            <button type="button" className="badge-dev__wifi-btn"
              disabled={!ssid || wifiBusy} onClick={() => void onConnectWifi()}>
              {wifiBusy ? '配网中…' : '连接 WiFi'}
            </button>
            {wifiMsg && <p className="badge-dev__hint">{wifiMsg}</p>}
            <p className="badge-dev__meta">吧唧仅支持 2.4GHz；配网后会重启，蓝牙需重新连接</p>
          </div>
          <p className="badge-dev__meta">固件 v{state.fwVer}{state.connError ? ' · ⚠连接错误' : ''}</p>
        </div>
      )}
    </div>
  );
}
