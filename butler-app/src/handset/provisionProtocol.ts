/**
 * 手机 ↔ 座机的配网协议(2026-09-22)。**纯的**:UUID、分帧编解码、人话。
 * 真正的蓝牙在 `handsetBle.ts`,流程在 `provisionMachine.ts`。
 *
 * 派那一侧是 `phone-bridge/provision.py`,**UUID 与帧头逐字相同**。
 * 改这里就得改那边,不然扫得到、连不上,而且两头都不报错。
 *
 * ## 为什么是 BLE 而不是「派自己开热点」
 *
 * Ben 定的硬要求是「整套流程在客户端里完成」。决定性的一条是:这条流程的最后一步要
 * 拿账号的会话令牌去中转换一张设备令牌(`/register-device`),**那一下手机必须有外网**。
 * 派开热点时手机连的是一个 local-only 网(Android 的 `WifiNetworkSpecifier`),
 * 那期间手机没有外网 —— 于是「配网」和「进房」在同一条流程里互相打架。
 * 加上 `WifiNetworkSpecifier` 在 Android 10+ / 9- 是两套 API、每次都要弹系统对话框、
 * 退出 App 就断,而我们没有真机可验。BLE 这边手机全程不离开自己的网,
 * 也是市面上智能设备的标准做法。完整的权衡写在 `docs/交接-0922-座机配网走App.md` 第二节。
 */

/** 与 phone-bridge/provision.py 的 `SERVICE_UUID` 逐字相同。 */
export const HANDSET_SERVICE = '8f5a7b10-4c3d-4a9e-9b21-6d0c5e7a1f00';
/** 派 → 手机:一条 JSON 的状态。notify。 */
export const CHAR_STATUS = '8f5a7b11-4c3d-4a9e-9b21-6d0c5e7a1f00';
/** 派 → 手机:扫到的 Wi-Fi 列表。notify。 */
export const CHAR_NETWORKS = '8f5a7b12-4c3d-4a9e-9b21-6d0c5e7a1f00';
/** 手机 → 派:命令。write。 */
export const CHAR_COMMAND = '8f5a7b13-4c3d-4a9e-9b21-6d0c5e7a1f00';

/**
 * 广播名的前缀。**只拿来显示,不拿来找设备** ——
 * 名字进的是扫描响应包(「工作台座机-XXXX」是 20 个字节,和一个 128 位 UUID
 * 挤不进同一个 31 字节的广播包),而扫描响应在某些机型上会迟到甚至不来。
 * 找设备一律按 `HANDSET_SERVICE` 过滤。
 */
export const HANDSET_NAME_PREFIX = '工作台座机-';

/** 名字没拿到时显示的那一句。**不编一个假名字**。 */
export const HANDSET_UNNAMED = '座机(名字还没报上来)';

export function handsetLabel(name: string | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? HANDSET_UNNAMED : trimmed;
}

// ———————————————————————— 分帧 ————————————————————————
//
// 协商前的 ATT MTU 是 23,净荷只有 20 字节;协商后 Android 上通常是 185,**但不保证**。
// 所以两头都不假设一条消息装得下,统一分帧:
//
//   每一帧 = 1 字节帧头 + 净荷;帧头 0x01 = 后面还有,0x00 = 最后一帧。
//
// 为什么不用"末尾加换行"那种分隔符:JSON 里可以合法地出现换行,真出现时表现是
// "偶尔丢一条消息",最难查的那一类。

export const FRAME_MORE = 0x01;
export const FRAME_LAST = 0x00;

/** 一条消息 → 若干帧。`mtu` 是协商后的 ATT MTU(净荷 = mtu - 3 - 1)。 */
export function encodeFrames(payload: unknown, mtu = 23): Uint8Array[] {
  const room = Math.max(1, Math.floor(mtu) - 3 - 1);
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const frames: Uint8Array[] = [];
  for (let start = 0; start < Math.max(raw.length, 1); start += room) {
    const chunk = raw.subarray(start, start + room);
    const last = start + room >= raw.length;
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = last ? FRAME_LAST : FRAME_MORE;
    frame.set(chunk, 1);
    frames.push(frame);
  }
  return frames;
}

/**
 * 把一串帧拼回一条消息。**读不懂就扔,绝不抛** —— 这条链路上任何一个字节都可能是
 * 别人的调试器写进来的,而一次异常会把整条 BLE 连接的回调链打断。
 */
export class FrameAssembler {
  /** 攒到这么多字节还没等到最后一帧就整个扔掉(防「写了一串 0x01 就走了」)。 */
  static readonly LIMIT = 8 * 1024;
  private buffer: number[] = [];

  feed(frame: Uint8Array): unknown | null {
    if (frame.length === 0) return null;
    const head = frame[0];
    if (head !== FRAME_MORE && head !== FRAME_LAST) {
      this.buffer = [];
      return null;
    }
    for (let i = 1; i < frame.length; i += 1) this.buffer.push(frame[i]);
    if (this.buffer.length > FrameAssembler.LIMIT) {
      this.buffer = [];
      return null;
    }
    if (head === FRAME_MORE) return null;
    const raw = new Uint8Array(this.buffer);
    this.buffer = [];
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return null;
    }
  }
}

// ———————————————————————— 派报上来的两条 ————————————————————————

/** 派报的相位。与 provision.py 里那七个常量逐字相同。 */
export type HandsetPhase = 'booting' | 'waiting' | 'scanning' | 'connecting' | 'online' | 'linking' | 'quiet';

export interface HandsetStatus {
  phase: HandsetPhase;
  /** 一句人话。**原样显示,不再包一层** —— 派那边已经写好了。 */
  text: string;
  ssid: string;
  ip: string;
  /** 机器码(`bad_password` 之类)。没出事是空串。 */
  error: string;
  /** 令牌交下去了没有。 */
  linked: boolean;
  /** 这台派在账号里的 id。手机拿它去中转 `/register-device` 登记。 */
  deviceId: string;
  /** 广播名,显示用。 */
  name: string;
}

export interface HandsetNetwork {
  ssid: string;
  /** 0~100。 */
  signal: number;
  /** 空串 = 开放网(不要密码)。 */
  security: string;
  /** 派这会儿连着的就是它。 */
  inUse: boolean;
  /** 派以前连过这个网。 */
  saved: boolean;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 一条状态。**缺字段不当错**:派上那一版可能比手机这一版老,
 * 少一个字段就整条不认的话,升级顺序一反就全瘫。
 */
export function parseStatus(raw: unknown): HandsetStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const one = raw as Record<string, unknown>;
  const phase = str(one.phase);
  if (phase === '') return null;
  return {
    phase: phase as HandsetPhase,
    text: str(one.text),
    ssid: str(one.ssid),
    ip: str(one.ip),
    error: str(one.error),
    linked: one.linked === true,
    deviceId: str(one.device_id),
    name: str(one.name),
  };
}

export function parseNetworks(raw: unknown): HandsetNetwork[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const list = (raw as Record<string, unknown>).networks;
  if (!Array.isArray(list)) return null;
  const out: HandsetNetwork[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const one = item as Record<string, unknown>;
    const ssid = str(one.ssid);
    if (ssid === '') continue;
    out.push({
      ssid,
      signal: typeof one.signal === 'number' ? Math.max(0, Math.min(100, one.signal)) : 0,
      security: str(one.security),
      inUse: one.in_use === true,
      saved: one.saved === true,
    });
  }
  return out;
}

// ———————————————————————— 手机发下去的四条 ————————————————————————

export type HandsetCommand =
  | { op: 'status' }
  | { op: 'scan' }
  | { op: 'connect'; ssid: string; psk: string }
  | { op: 'link'; relay: string; token: string; device_id?: string; name?: string };

// ———————————————————————— 文案 ————————————————————————
//
// 只放**手机这一侧**才知道的那几句(蓝牙没开、权限没给、找不到座机)。
// 派那边的失败(密码错、找不到这个网)由派自己的 `text` 原样带上来 ——
// 一句话两处维护,迟早对不上。

export const TEXT = {
  scanning: '正在找附近的座机…',
  wifiScanning: '正在让座机扫一遍附近的 Wi-Fi…',
  /** 找了一圈没有。**说清下一步做什么**,而不只是"没找到"。 */
  none: '附近没找到座机。确认座机通着电,而且是刚开机不久 —— 它连不上 Wi-Fi 一分钟后才会亮出来让人配',
  bluetoothOff: '手机的蓝牙没开。打开蓝牙再试一次',
  noPermission: '没有蓝牙权限,找不了座机。在系统设置里给「事务官」打开「附近的设备」再回来',
  /**
   * 安卓上系统定位开关关着(2026-09-27,卡 RM ③)。小米(HyperOS)那时**蓝牙扫描静默回空** ——
   * 于是屏上转十秒然后说「附近没找到座机」,一句完全指错方向的话。
   * 这句里要说清**我们不要他的位置**:那是安卓的规矩,不写清他不会去开。
   */
  locationOff: '这台手机的系统「位置信息」关着 —— 安卓不许在这种状态下扫蓝牙,所以找不到座机(我们不要你的位置,只是系统这么定的)。打开位置信息再试一次',
  connecting: '正在连上座机…',
  connectFailed: '连不上这台座机。离它近一点(一米以内)再试一次',
  wifiEmpty: '座机一个 Wi-Fi 都没扫到。它只认 2.4G 的网,而且要离路由器近一些',
  /**
   * 手机没登录账号、**又问不到电脑**时的最后一句(2026-09-27,卡 HS 之后只剩这一种情形:
   * 连 8791 的客户端都没有)。常态那条路是「请电脑代办」,见 handsetLink.ts。
   */
  needAccount: '这台手机还没登录账号,也联系不上电脑,没法把座机记到账号下。先在设置里登录一次',
  /** 电脑不在线 / 手机这会儿没网(卡 HS)。**网那一步已经做完了**,所以只退到「重试记账号」。 */
  linkNoComputer: '这会儿联系不上你的电脑,座机还没记到账号下。等电脑开着(或者跟它连同一个 Wi-Fi)再点「重试记账号」—— 座机的网已经配好了,不用重配',
  /** 电脑不认这台手机了(配对被解除 / 工作台重置过)。 */
  linkNotPaired: '你的电脑不认这台手机了(配对可能被解除过)。重新扫一次码配对,再点「重试记账号」—— 座机的网已经配好了',
  /** 电脑或中转回来的东西缺字段。**不把半把钥匙交给座机**。 */
  linkRelayBad: '电脑回来的内容缺东西,没拿到座机要的那把钥匙。点「重试记账号」再来一次 —— 网不用重配',
  linkFailed: '座机连上网了,但没记进你的账号。点「重试」再来一次 —— 网络那一步不用重做',
  done: '座机已上线',
  /** 断在半路。**说清哪一半已经成了**。 */
  lost: '和座机断开了。刚才的进度还在座机上(网已经配好的话它不会丢),回到上一步重来一次',
} as const;

/** 信号格数(四格)。**不显示 dBm** —— 那个数没人看得懂。 */
export function signalBars(signal: number): number {
  if (signal >= 75) return 4;
  if (signal >= 55) return 3;
  if (signal >= 35) return 2;
  return 1;
}

/** 「这个网要不要密码」。开放网的 security 是空串。 */
export function needsPassword(network: HandsetNetwork): boolean {
  return network.security.trim() !== '';
}

/**
 * 列表排序:**手机自己连着的那个排最前**(Ben 的原话「当前手机连着的那个排最前」),
 * 其次是座机连着的,再次存过的,最后按信号。
 *
 * 手机连的是哪个网这件事**我们并不真的知道** —— Android 上读 SSID 要定位权限
 * 且 API 各版本不一(见文档「没做的」第 3 条)。所以 `phoneSsid` 是可选的:
 * 给得出就用,给不出这个排序就退化成「座机连着的排最前」,而不是编一个。
 */
export function sortNetworks(list: readonly HandsetNetwork[], phoneSsid?: string): HandsetNetwork[] {
  const mine = (phoneSsid ?? '').trim();
  return [...list].sort((a, b) => {
    const rank = (n: HandsetNetwork): number => {
      if (mine !== '' && n.ssid === mine) return 0;
      if (n.inUse) return 1;
      if (n.saved) return 2;
      return 3;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    if (a.signal !== b.signal) return b.signal - a.signal;
    return a.ssid.localeCompare(b.ssid);
  });
}
