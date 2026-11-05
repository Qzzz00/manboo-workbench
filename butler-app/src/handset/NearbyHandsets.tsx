/**
 * **附近有没有座机**(2026-09-30,维护者:「最好变成手机只要打开座机配置那个页面,就显示附近有没有座机」)。
 *
 * 现场:座机连着一个进不了房的网,房间那条路断了;以前手机要自己点「添加座机」才开始扫,
 * 他不知道座机其实就在旁边开着蓝牙等人。座机那头 2026-09-30 起「进不了房就一直开蓝牙」
 * (phone-bridge/provision.py `_want_advertise`),这一头一打开「座机」页就扫一遍、把附近的列出来。
 *
 * - 扫 `NEARBY_SCAN_MS` 就停(不一直开着耗电);离开这一页也停。
 * - 扫不了(没权限 / 蓝牙关 / 定位关):**原样说是哪个开关**,不说「附近没有」—— 那句话会把人指错方向。
 * - 点「配这台」进添加那一页(那一页自己再扫、连、配网、记账号,流程一步不改)。
 */
import { useEffect, useMemo, useState } from 'react';
import { createHandsetBle, HandsetBleError, type HandsetBle } from './handsetBle';
import type { FoundHandset } from './provisionMachine';

/** 扫多久就停。座机广播的间隔在一秒内,十几秒足够看见旁边那一台。 */
export const NEARBY_SCAN_MS = 15_000;
export const NEARBY_NONE_TEXT = '附近没发现等着配的座机(已经在线的座机不开蓝牙,是正常的)';

type Seen =
  | { kind: 'scanning', found: readonly FoundHandset[] }
  | { kind: 'done', found: readonly FoundHandset[] }
  | { kind: 'failed', text: string };

export function NearbyHandsets({ onAdd, ble: injected }: { onAdd: () => void, ble?: HandsetBle }) {
  const ble = useMemo(() => injected ?? createHandsetBle(), [injected]);
  const [seen, setSeen] = useState<Seen>({ kind: 'scanning', found: [] });

  useEffect(() => {
    let alive = true;
    let latest: readonly FoundHandset[] = [];
    const timer = setTimeout(() => {
      void ble.stopScan().catch(() => {});
      if (alive) setSeen({ kind: 'done', found: latest });
    }, NEARBY_SCAN_MS);
    ble.scan((devices) => {
      latest = devices;
      if (alive) setSeen(prev => prev.kind === 'failed' ? prev : { kind: prev.kind, found: devices });
    }).catch((error: unknown) => {
      clearTimeout(timer);
      if (!alive) return;
      setSeen({ kind: 'failed', text: error instanceof HandsetBleError ? error.message : '这会儿扫不了蓝牙' });
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      void ble.stopScan().catch(() => {});
    };
  }, [ble]);

  if (seen.kind === 'failed') return <p className="ba-settings__line ba-settings__dim">附近有没有座机:{seen.text}</p>;
  if (seen.found.length === 0) {
    return (
      <p className="ba-settings__line ba-settings__dim">
        {seen.kind === 'scanning' ? '正在找附近的座机…' : NEARBY_NONE_TEXT}
      </p>
    );
  }
  return (
    <div className="ba-settings__line">
      {seen.found.map(one => (
        <div className="ba-row" key={one.id}>
          <span>附近有一台座机在等着配:{one.name}</span>
          <button type="button" className="ba-btn ba-btn--ghost" onClick={onAdd}>配这台</button>
        </div>
      ))}
    </div>
  );
}
