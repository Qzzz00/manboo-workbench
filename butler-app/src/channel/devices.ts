/**
 * 手机这一侧的「在线设备」与「传输记录」(2026-09-21,设备间传文件那张卡)。
 *
 * 房里现在可能有好几台:他的两台电脑、这台手机、也许还有另一台手机。所以「发文件」
 * 多了一步 —— **发给哪一台**。这个文件做三件事:
 *
 *   1. 问一份在线设备表(`GET /devices/online`,走 routedClient:在家直连 8791,
 *      出门经房间由工人代理,两条路同一份数据);
 *   2. 把**自己**从选单里去掉(发给自己没有意义,而且会把文件原样兜回来);
 *   3. 问一份最近的传输记录(`GET /devices/transfers`),记录面板里列出来。
 *
 * 纪律:**取不到就如实说取不到**,不拿一份空列表冒充「房里没有别的设备」——
 * 那会让他以为电脑不在线,而其实只是这会儿问不到。
 */
import type { ApiClient } from '../api/client';

/**
 * 2026-09-22 多了 `handset`:树莓派上那只实体话筒(workbench-plugin/src/server/devices.ts
 * 的 `deviceKindOf` 按配对时报的 `platform` 分)。上一版这里只认 `mac | phone`,
 * 于是话筒那一条**被当成读不懂丢掉了** —— 座机页要在一行状态里说「话筒在线/离线」,
 * 丢掉它就只能说「问不到」,而那是假的。
 */
export type WbchDeviceKind = 'mac' | 'phone' | 'handset';

/** 「发文件」那个选单里该出现的那几种。**话筒不在里头**:发不了文件给一只听筒。 */
export const WBCH_FILE_TARGET_KINDS: readonly WbchDeviceKind[] = ['mac', 'phone'];

export interface WbchDevice {
  identity: string;
  device_id: string;
  name: string;
  kind: WbchDeviceKind;
}

export interface WbchTransfer {
  at: string;
  direction: 'out' | 'in';
  peer: string;
  name: string;
  bytes: number;
  ok: boolean;
  error?: string;
}

/** 「电脑」/「手机」/「话筒」。选单与记录面板里都用它,两处不会长出两种叫法。 */
export function wbchKindText(kind: WbchDeviceKind): string {
  if (kind === 'mac') return '电脑';
  return kind === 'handset' ? '话筒' : '手机';
}

/** 一条回包 → 一台设备。认不出来就丢掉(这是网络上来的东西)。 */
export function parseWbchDevice(raw: unknown): WbchDevice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const identity = text(item.identity);
  const kind = item.kind === 'mac' || item.kind === 'phone' || item.kind === 'handset' ? item.kind : undefined;
  if (identity === undefined || kind === undefined) return null;
  return { identity, device_id: text(item.device_id) ?? identity, name: text(item.name) ?? identity, kind };
}

export function parseWbchTransfer(raw: unknown): WbchTransfer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.name !== 'string' || item.name === '') return null;
  if (item.direction !== 'out' && item.direction !== 'in') return null;
  return {
    at: typeof item.at === 'string' ? item.at : '',
    direction: item.direction,
    peer: typeof item.peer === 'string' && item.peer !== '' ? item.peer : '不知道是谁',
    name: item.name,
    bytes: typeof item.bytes === 'number' && Number.isFinite(item.bytes) ? item.bytes : 0,
    ok: item.ok !== false,
    ...(typeof item.error === 'string' && item.error !== '' ? { error: item.error } : {}),
  };
}

export interface WbchDevicesResult {
  /** 除自己以外、此刻在线的。 */
  devices: readonly WbchDevice[];
  /** 这份表已经旧了(工人掉线),或者压根没问到。一句人话,**原样显示**。 */
  note?: string;
}

/**
 * 问一份在线设备表。**不抛** —— 发文件那一步不该因为这一问失败就整个用不了。
 *
 * `kinds` 缺省是 `WBCH_FILE_TARGET_KINDS`(电脑 + 手机),**与 2026-09-21 那一版逐字同样的
 * 结果** —— 发文件的选单一个字没变。座机页那一行状态要看话筒,明着把它要回来。
 */
export async function fetchWbchDevices(
  client: ApiClient,
  selfIdentity: string | null,
  options: { kinds?: readonly WbchDeviceKind[] } = {},
): Promise<WbchDevicesResult> {
  const kinds = options.kinds ?? WBCH_FILE_TARGET_KINDS;
  const res = await client.json<{ devices?: unknown; stale?: unknown; note?: unknown }>('/devices/online');
  if (!res.ok) return { devices: [], note: res.error };
  const raw = Array.isArray(res.data.devices) ? res.data.devices : [];
  const devices: WbchDevice[] = [];
  for (const item of raw) {
    const device = parseWbchDevice(item);
    // 自己不进选单:发给自己没有意义,而且工人会把它原样兜回来。
    if (device === null || device.identity === selfIdentity) continue;
    if (!kinds.includes(device.kind)) continue;
    devices.push(device);
  }
  const note = typeof res.data.note === 'string' && res.data.note !== '' ? res.data.note : undefined;
  return { devices, ...(note === undefined ? {} : { note }) };
}

/** 问一份最近的传输记录。同样**不抛**。 */
export async function fetchWbchTransfers(client: ApiClient): Promise<readonly WbchTransfer[]> {
  const res = await client.json<{ records?: unknown }>('/devices/transfers');
  if (!res.ok) return [];
  const raw = Array.isArray(res.data.records) ? res.data.records : [];
  const out: WbchTransfer[] = [];
  for (const item of raw) {
    const record = parseWbchTransfer(item);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * 记录里的时刻(ISO,UTC)→ 手机本地的「09-21 18:11」。
 * 2026-09-25(卡 J):以前直接截 ISO 串,显示的是 UTC —— 在北京差 8 个小时,晚上九点传的写着「13:42」。
 * 读不出来就原样截(不编一个时刻)。
 */
export function wbchLocalWhen(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(5, 16).replace('T', ' ');
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 一条记录 → 一句给人看的话。**不含文件内容**,只有名字、大小、对方、时间。 */
export function wbchTransferLine(record: WbchTransfer): string {
  const when = wbchLocalWhen(record.at);
  const arrow = record.direction === 'out' ? '发给' : '收自';
  if (!record.ok) return `${when} ${arrow} ${record.peer}:${record.name} 没成 —— ${record.error ?? '没说原因'}`;
  return `${when} ${arrow} ${record.peer}:${record.name} ${wbchSizeText(record.bytes)}`;
}

export function wbchSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不详';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
