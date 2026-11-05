/**
 * 给**已经在线的**座机换 Wi-Fi(2026-09-22 晚,Ben:配网优先做,他要用它给派换网)。
 *
 * 和 `provisionMachine.ts` 那条(蓝牙、开箱第一次配网)是**两条不同的路**:
 *
 * | | 走哪条链路 | 什么时候用 |
 * |---|---|---|
 * | `AddHandsetPage`(蓝牙) | BLE | 座机**没网**:开箱第一次,或换了地方连不上任何存过的网 |
 * | 这一份 | **房间**(LiveKit 数据通道 `wb.rpc`) | 座机**已经在线**:去比赛现场之前先把那边的网配上 |
 *
 * 座机已经在房里的时候,房间这条链路是**现成的** —— 手机不必靠近它、不必要蓝牙权限、
 * 不必等那 60 秒的待配网窗口。反过来,座机掉网之后房间这条路就不存在了,那时只有蓝牙。
 * **两条都要,不是二选一。**
 *
 * 派那一侧是 `phone-bridge/netcfg.py`,**字段逐字相同**。
 *
 * ## 「换成了」是什么意思
 *
 * 不是「座机连上那个路由器了」—— 比赛现场那种要在网页上点同意才放行的网,
 * nmcli 一样报成功。判据是**座机在新网上重新回到了房间里**:它切过去之后会主动断开、
 * 重进;进得来才算成,90 秒进不来它自己把网切回去,并如实报「没换成,东西还在」。
 * 所以这条流程的等待时间**以分钟计**,界面上要说清楚在等什么。
 *
 * ## 密码到哪儿为止
 *
 * 只在两个地方:① 输入框里那个 state;② 发出去的那条消息(**点名发给座机**,
 * `destinationIdentities`,房里的电脑与另一台手机收不到)。**不进日志、不进任何结果**。
 * 老实说一句代价:这条消息经的是中转上的 LiveKit 服务器(TLS,不是端到端加密),
 * 服务器的运营者理论上看得见 —— 那台服务器是 Ben 自己的。
 */
import type { HandsetNetwork } from './provisionProtocol.ts';
import { parseNetworks, sortNetworks } from './provisionProtocol.ts';

/** 与 `netcfg.py` 的 `MSG_TYPE` 逐字相同。**不叫 `call`** —— 那是来电那条,工人会认。 */
export const NETCFG_TYPE = 'netcfg';
/** 与 workbench-plugin/src/server/channel.ts 的 `CHANNEL_RPC_TOPIC` 同一个字符串。 */
export const NETCFG_TOPIC = 'wb.rpc';

export type NetcfgAction = 'scan' | 'switch';

/** 扫一遍 / 换网。`psk` 空串 = 开放网(真的不要密码)。 */
export function scanRequest(id: string): string {
  return JSON.stringify({ id, type: NETCFG_TYPE, action: 'scan' });
}

export function switchRequest(id: string, ssid: string, psk: string): string {
  return JSON.stringify({ id, type: NETCFG_TYPE, action: 'switch', ssid, psk });
}

export interface NetcfgScanReply {
  id: string;
  action: 'scan';
  ok: boolean;
  networks: readonly HandsetNetwork[];
  text: string;
}

export interface NetcfgSwitchReply {
  id: string;
  action: 'switch';
  ok: boolean;
  code: string;
  text: string;
  ssid: string;
  ip: string;
  /** 座机已经切回原来的网了。界面上那句话完全不同。 */
  rolledBack: boolean;
}

export type NetcfgReply = NetcfgScanReply | NetcfgSwitchReply;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 座机回来的一行 JSON → 一条结果。**读不懂一律 null,绝不抛**。
 *
 * 这条 topic 上还跑着来电、字幕、缓冲语和工人的应答 —— 认不得的原样忽略,
 * 而不是当成一条坏掉的换网结果(那会让界面停在「正在换」上再也不动)。
 */
export function parseNetcfgReply(raw: string): NetcfgReply | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type !== NETCFG_TYPE) return null;
  const id = str(msg.id);
  if (id === '') return null;
  if (msg.action === 'scan') {
    // **复用蓝牙那条的那一份**:两条路上的 Wi-Fi 列表是同一个 `parse_wifi_list`
    // 产出的同一个形状,解析抄第二遍迟早会有一处对不上(`in_use` → `inUse` 就是其中一处)。
    const networks = parseNetworks({ networks: msg.networks }) ?? [];
    return { id, action: 'scan', ok: msg.ok === true, networks, text: str(msg.text) };
  }
  if (msg.action === 'switch') {
    return {
      id, action: 'switch', ok: msg.ok === true, code: str(msg.code), text: str(msg.text),
      ssid: str(msg.ssid), ip: str(msg.ip), rolledBack: msg.rolled_back === true,
    };
  }
  return null;
}

// ———————————————————————— 流程 ————————————————————————

/** 换网等多久算没回来。比派那头的 90 + 60 秒再多留一点 —— **手机不能比座机先放弃**:
 * 先放弃的话它会在座机正把网切回去的时候说「失败了」,而三十秒后座机其实回来了。 */
export const SWITCH_TIMEOUT_MS = 200_000;
/** 扫一遍等多久。派上 `--rescan yes` 在 Zero 2W 上要几秒。 */
export const SCAN_TIMEOUT_MS = 45_000;

export type SwitchStep =
  | { kind: 'offline' }
  | { kind: 'scanning' }
  | { kind: 'networks'; list: readonly HandsetNetwork[]; busy: boolean }
  | { kind: 'password'; network: HandsetNetwork }
  | { kind: 'switching'; ssid: string }
  | { kind: 'done'; ssid: string; ip: string }
  | { kind: 'failed'; text: string; network?: HandsetNetwork; rolledBack: boolean };

export interface SwitchState {
  step: SwitchStep;
  /** 座机在房里的身份(`fetchWbchDevices` 给的)。没有就是座机不在线。 */
  handset?: string;
  /** 手机这会儿连着的 Wi-Fi(知道的话),用来把那一个排最前。 */
  phoneSsid?: string;
}

export type SwitchEvent =
  | { type: 'handset'; identity: string; name: string }
  | { type: 'noHandset' }
  | { type: 'reply'; reply: NetcfgReply }
  | { type: 'sendFailed'; text: string }
  | { type: 'timeout' }
  | { type: 'rescan' }
  | { type: 'choose'; network: HandsetNetwork }
  | { type: 'submit'; psk: string }
  | { type: 'back' }
  | { type: 'retry' };

export type SwitchEffect =
  | ['scan']
  | ['switch', string, string]   // ssid, psk —— **密码只在这里出现一次**
  | ['done'];

export interface SwitchStepped {
  state: SwitchState;
  effects: readonly SwitchEffect[];
}

export const NO_HANDSET_TEXT = '现在看不到在线的座机。它要先连上网、进到房间里,这条路才走得通;座机从来没配过网的话,用上面那条「添加座机」(蓝牙)。';
export const SWITCH_TIMEOUT_TEXT = '等了三分多钟没等到座机的回话。它可能还在换网的路上 —— 过一会儿回到这一页再看一眼座机在不在线。';
export const SEND_FAILED_TEXT = '这条没发出去(手机和房间断开了)。检查一下手机的网,再试一次。';

export function initialSwitchState(phoneSsid?: string): SwitchState {
  return { step: { kind: 'offline' }, ...(phoneSsid === undefined ? {} : { phoneSsid }) };
}

function at(state: SwitchState, step: SwitchStep, effects: readonly SwitchEffect[] = []): SwitchStepped {
  return { state: { ...state, step }, effects };
}

export function switchStep(state: SwitchState, event: SwitchEvent): SwitchStepped {
  const current = state.step;

  // 座机在不在线是**随时**会变的一件事,所以这两条不按相位分。
  if (event.type === 'noHandset') {
    // 正在换网的时候它当然不在线 —— **那正是它在干活**,不该被当成"座机没了"。
    if (current.kind === 'switching') return { state, effects: [] };
    return at({ ...state, handset: undefined }, { kind: 'offline' });
  }
  if (event.type === 'handset') {
    const next = { ...state, handset: event.identity };
    if (current.kind === 'offline') return at(next, { kind: 'scanning' }, [['scan']]);
    return { state: next, effects: [] };
  }

  if (event.type === 'sendFailed') {
    return at(state, { kind: 'failed', text: event.text || SEND_FAILED_TEXT, rolledBack: false });
  }

  if (event.type === 'timeout') {
    if (current.kind === 'scanning') {
      return at(state, { kind: 'failed', text: '座机没回话。它在线吗?过一会儿再试一次。', rolledBack: false });
    }
    if (current.kind === 'switching') {
      return at(state, { kind: 'failed', text: SWITCH_TIMEOUT_TEXT, rolledBack: false });
    }
    return { state, effects: [] };
  }

  switch (current.kind) {
    case 'offline':
      return { state, effects: [] };

    case 'scanning': {
      if (event.type !== 'reply' || event.reply.action !== 'scan') return { state, effects: [] };
      if (!event.reply.ok) {
        return at(state, { kind: 'failed', text: event.reply.text || '座机扫不到 Wi-Fi', rolledBack: false });
      }
      return at(state, { kind: 'networks', list: event.reply.networks, busy: false });
    }

    case 'networks': {
      if (event.type === 'rescan') return at(state, { kind: 'networks', list: current.list, busy: true }, [['scan']]);
      if (event.type === 'reply' && event.reply.action === 'scan' && event.reply.ok) {
        return at(state, { kind: 'networks', list: event.reply.networks, busy: false });
      }
      if (event.type === 'choose') return at(state, { kind: 'password', network: event.network });
      return { state, effects: [] };
    }

    case 'password': {
      if (event.type === 'back') return at(state, { kind: 'networks', list: [], busy: true }, [['scan']]);
      if (event.type === 'submit') {
        return at(state, { kind: 'switching', ssid: current.network.ssid },
          [['switch', current.network.ssid, event.psk]]);
      }
      return { state, effects: [] };
    }

    case 'switching': {
      if (event.type !== 'reply' || event.reply.action !== 'switch') return { state, effects: [] };
      const reply = event.reply;
      if (reply.ok) return at(state, { kind: 'done', ssid: reply.ssid || current.ssid, ip: reply.ip }, [['done']]);
      // 派那边已经写好了人话(「密码不对。重新输一遍试试」/「已经切回原来的网」),**原样用**。
      return at(state, { kind: 'failed', text: reply.text || '没换成', rolledBack: reply.rolledBack });
    }

    case 'failed': {
      if (event.type !== 'retry') return { state, effects: [] };
      // 回到「选 Wi-Fi」而不是从头来:座机还在(或者刚切回来),没必要重新找一遍。
      return at(state, { kind: 'networks', list: [], busy: true }, [['scan']]);
    }

    case 'done':
      return { state, effects: [] };
  }
}

/** 这一步该显示什么标题。四步。 */
export const SWITCH_TITLE: Record<SwitchStep['kind'], string> = {
  offline: '座机不在线',
  scanning: '让座机扫一遍',
  networks: '选 Wi-Fi',
  password: '输密码',
  switching: '正在换网',
  done: '换好了',
  failed: '没换成',
};

/** 「正在换网」那一屏下面那句话。**说清在等什么、要等多久**。 */
export const SWITCHING_NOTE = '座机正在切到新的网。它会断开一下再连回来,这一步最多要三分钟 —— 这期间它接不了电话,别拔电。';

/** 换好了之后那句话。带上地址:Ben 排查时第一个要的就是它。 */
export function doneText(ssid: string, ip: string): string {
  return ip === '' ? `座机已经连上 ${ssid} 了` : `座机已经连上 ${ssid},地址 ${ip}`;
}

export function orderedSwitchNetworks(state: SwitchState): HandsetNetwork[] {
  if (state.step.kind !== 'networks') return [];
  return sortNetworks(state.step.list, state.phoneSsid);
}
