/**
 * 展示台配对框(2026-09-11 手机配对与设备令牌):工作台不在本机、又还没有令牌时,显示一个输码框。
 * 输对 6 位配对码 → 拿到令牌存进 localStorage → 整页刷新重连(kiosk 上最稳的做法)。
 * 已经有令牌、或工作台就在本机(免令牌)时什么都不渲染;连着的时候也不渲染。
 */
import { useState } from 'react';
import { claimWorkbenchToken, isLoopbackWorkbench, resolveWorkbenchToken, saveWorkbenchToken } from './workbenchToken';

function storage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export function WorkbenchPairing({ wsUrl, connected, fetchImpl, reload }: {
  wsUrl: string;
  connected: boolean;
  fetchImpl?: typeof fetch;
  reload?: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);

  const hasToken = resolveWorkbenchToken(typeof window === 'undefined' ? '' : window.location.search, storage()) !== null;
  if (connected || claimed || hasToken || isLoopbackWorkbench(wsUrl)) return null;

  async function submit() {
    setBusy(true);
    setMessage(null);
    const result = await claimWorkbenchToken(fetchImpl ?? fetch, wsUrl, code, '展示台');
    setBusy(false);
    if (!result.ok) { setMessage(result.error); return; }
    saveWorkbenchToken(storage(), result.token);
    setClaimed(true);
    (reload ?? (() => window.location.reload()))();
  }

  return (
    <form
      className="dp-pair"
      aria-label="配对工作台"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <p className="dp-pair-hint">还没和工作台配对。在工作台「设置 → 手机与设备」里生成配对码,输在这里:</p>
      <input
        className="dp-pair-inp"
        aria-label="配对码"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
      />
      <button className="dp-pair-btn" type="submit" disabled={busy || code.length !== 6}>
        {busy ? '配对中…' : '配对'}
      </button>
      {message !== null && <p className="dp-pair-msg" role="status">{message}</p>}
    </form>
  );
}
