/* 吧唧 BLE 协议镜像 + 连接管理（模块单例）。
 * 帧格式/STAT 布局镜像固件 badge_ctrl.h（spec 2026-07-09-badge-ble-app-design §1）。
 * 纯函数（encodeFrame/decodeStat/macToDeviceId）可脱离插件单测，对拍真机验过的字节。
 */

import { BleClient, numbersToDataView, dataViewToNumbers } from '@capacitor-community/bluetooth-le';

export const BADGE_SERVICE = 'e3f31935-6dfd-4859-ae76-8a8f12ef80d3';
export const BADGE_CTRL_CHAR = 'e3f31935-6dfd-4859-ae76-8a8f12ef80d4';
export const BADGE_STAT_CHAR = 'e3f31935-6dfd-4859-ae76-8a8f12ef80d5';

export const OP_SET_BRIGHTNESS = 0x01;
export const OP_SET_SCREEN = 0x02;
export const OP_SET_VOLUME = 0x03;
export const OP_GET_STATE = 0x10;
export const OP_WIFI_CONFIG = 0x20;

const FRAME_MAGIC = 0xa1;
const STAT_LEN = 14;

export type BadgeState = {
  screenOn: boolean;
  connError: boolean;
  wifiConnected: boolean; // STAT flags bit2
  brightness: number; // 设备值 0-255
  volume: number;     // 0-100
  faceState: number;
  lastStatus: number;
  fwVer: number;
  mac: string;        // "28:84:85:90:60:3E"
  battery: number | null; // 电量 0-100；null=无电池/未知/旧固件(14字节STAT)
};

/** [0xA1][opcode][len][payload?] —— payload 省略=GET_STATE 空帧(len=0)。 */
export function encodeFrame(opcode: number, payload?: number): number[] {
  if (payload === undefined) return [FRAME_MAGIC, opcode, 0x00];
  return [FRAME_MAGIC, opcode, 0x01, payload & 0xff];
}

/** 配网帧：[A1][20][len][ssid_len][ssid utf8][pwd_len][pwd utf8]。len=payload 字节数。 */
export function encodeWifiFrame(ssid: string, pwd: string): number[] {
  const s = Array.from(new TextEncoder().encode(ssid));
  const p = Array.from(new TextEncoder().encode(pwd));
  const payload = [s.length, ...s, p.length, ...p];
  return [FRAME_MAGIC, OP_WIFI_CONFIG, payload.length, ...payload];
}

/** STAT → 对象；≥14 字节有效（14=旧固件无电量，15=v2 尾含 battery byte14）。 */
export function decodeStat(bytes: number[]): BadgeState | null {
  if (!bytes || bytes.length < STAT_LEN) return null;
  const flags = bytes[1];
  const mac = bytes.slice(8, 14)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
  return {
    screenOn: (flags & 0x01) !== 0,
    connError: (flags & 0x02) !== 0,
    wifiConnected: (flags & 0x04) !== 0,
    brightness: bytes[2],
    volume: bytes[3],
    faceState: bytes[4],
    lastStatus: bytes[5],
    fwVer: bytes[6] | (bytes[7] << 8), // 小端
    mac,
    battery: bytes.length >= 15 ? (bytes[14] === 0xFF ? null : bytes[14]) : null,
  };
}

/** MAC → 后端 deviceId（去冒号小写）。P2 固件拉取 device id 最终对齐时同规则。 */
export function macToDeviceId(mac: string): string {
  return mac.replace(/:/g, '').toLowerCase();
}

// ---- 连接管理（模块单例；页面级：BadgeDevicePanel 挂载时 connect，卸载时 disconnect）----

export type ScanHit = { deviceId: string; name: string; rssi: number };

let s_conn: string | null = null; // 当前连接的插件 deviceId
let s_inited = false;

/** 初始化 BLE 栈（幂等）。Android 用 androidNeverForLocation 避免要定位权限。 */
export async function ensureReady(): Promise<void> {
  if (s_inited) return;
  await BleClient.initialize({ androidNeverForLocation: true });
  s_inited = true;
}

/** 扫描广播 BADGE_SERVICE 的设备。回调逐个上报，需自行去重。 */
export async function scan(onFound: (h: ScanHit) => void): Promise<void> {
  await ensureReady();
  await BleClient.requestLEScan({ services: [BADGE_SERVICE] }, (r) => {
    onFound({ deviceId: r.device.deviceId, name: r.device.name ?? r.localName ?? 'Aiboo', rssi: r.rssi ?? 0 });
  });
}

export async function stopScan(): Promise<void> {
  try { await BleClient.stopLEScan(); } catch { /* 未在扫描 */ }
}

/** 连接 + 订阅 STAT notify。onState 每次收到 STAT 触发（写命令回执 + 主动 GET_STATE）。 */
export async function connect(
  bleDeviceId: string,
  onState: (s: BadgeState) => void,
  onDisconnect: () => void,
): Promise<void> {
  await ensureReady();
  await stopScan();
  await BleClient.connect(bleDeviceId, () => { s_conn = null; onDisconnect(); });
  s_conn = bleDeviceId;
  try {
    await BleClient.startNotifications(bleDeviceId, BADGE_SERVICE, BADGE_STAT_CHAR, (dv) => {
      const st = decodeStat(dataViewToNumbers(dv));
      if (st) onState(st);
    });
    await requestState(); // 连上先拉一次当前状态填 UI 初值
  } catch (e) {
    s_conn = null;
    try { await BleClient.disconnect(bleDeviceId); } catch { /* transport 可能未建立，忽略 */ }
    throw e;
  }
}

export async function disconnect(): Promise<void> {
  if (!s_conn) return;
  const id = s_conn;
  s_conn = null;
  try { await BleClient.stopNotifications(id, BADGE_SERVICE, BADGE_STAT_CHAR); } catch { /* ignore */ }
  try { await BleClient.disconnect(id); } catch { /* ignore */ }
}

export function connectedDeviceId(): string | null {
  return s_conn;
}

/** 读当前连接协商的 ATT MTU（最大可写 payload = MTU-3）。未连返回 0。 */
export async function getBadgeMtu(): Promise<number> {
  if (!s_conn) return 0;
  try {
    return await BleClient.getMtu(s_conn);
  } catch {
    return 0;
  }
}

async function writeCtrl(frame: number[]): Promise<void> {
  if (!s_conn) throw new Error('未连接吧唧');
  await BleClient.write(s_conn, BADGE_SERVICE, BADGE_CTRL_CHAR, numbersToDataView(frame));
}

export async function setBrightness(pct: number): Promise<void> {
  await writeCtrl(encodeFrame(OP_SET_BRIGHTNESS, Math.max(0, Math.min(100, Math.round(pct)))));
}
export async function setScreen(on: boolean): Promise<void> {
  await writeCtrl(encodeFrame(OP_SET_SCREEN, on ? 1 : 0));
}
export async function setVolume(pct: number): Promise<void> {
  await writeCtrl(encodeFrame(OP_SET_VOLUME, Math.max(0, Math.min(100, Math.round(pct)))));
}
export async function requestState(): Promise<void> {
  await writeCtrl(encodeFrame(OP_GET_STATE));
}
/** 下发 WiFi 配网（SSID+密码）。吧唧写 NVS 后重启连接，状态经 STAT bit2 回报。 */
export async function setWifi(ssid: string, pwd: string): Promise<void> {
  await writeCtrl(encodeWifiFrame(ssid, pwd));
}
