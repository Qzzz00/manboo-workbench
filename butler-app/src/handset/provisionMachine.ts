/**
 * 「添加座机」那条流程(2026-09-22)。**纯 reducer**,不碰蓝牙、不发请求。
 *
 * Ben 定的那句是「整套流程我希望能在客户端里完成」。摊开来就是六步,
 * 每一步都在这一份里有一个相位,每一步失败都有一句人话和一颗「重试」:
 *
 *   找座机 → 选 Wi-Fi → 输密码 → 连 → 配对进房 → 座机已上线
 *
 * ## 为什么要一个 reducer 而不是几个 useState
 *
 * 这条流程有**两个说话的人**:人点的那几下,和座机那头自己冒出来的状态
 * (它可能在你还在输密码的时候自己连上了看门狗记着的那个网)。
 * 两边各自 setState 的写法在这种地方一定会出现「界面停在输密码页而座机早就上线了」。
 * 一个 reducer 把「谁说了什么」变成一串事件,顺序就只有一种解释。
 *
 * ## 副作用怎么出去
 *
 * reducer 回 `{ state, effects }`。`effects` 是几条指令,组件照着做:
 *   ('scan')            开始扫 BLE
 *   ('stopScan')        停
 *   ('connect', id)     连上这台座机
 *   ('send', command)   往座机写一条命令
 *   ('link')            去中转换一张设备令牌,然后把它写给座机
 *   ('disconnect')      断开
 * 做完了再把结果作为事件喂回来。**组件里不许有第二份判断**。
 */
import type { HandsetCommand, HandsetNetwork, HandsetStatus } from './provisionProtocol.ts';
import { TEXT, sortNetworks } from './provisionProtocol.ts';

/** 扫到的一台。`id` 是 BLE 那一层给的设备 id(Android 上是 MAC,iOS 上是 UUID)。 */
export interface FoundHandset {
  id: string;
  name: string;
  rssi?: number;
}

/** 失败发生在哪一步。**决定「重试」退回哪里** —— 网配好了就不该让人重配一遍。 */
export type FailedAt = 'scan' | 'connect' | 'wifi' | 'link';

export type ProvisionStep =
  | { kind: 'scanning'; found: readonly FoundHandset[] }
  | { kind: 'connecting'; device: FoundHandset }
  | { kind: 'networks'; device: FoundHandset; list: readonly HandsetNetwork[]; busy: boolean }
  | { kind: 'password'; device: FoundHandset; network: HandsetNetwork }
  | { kind: 'joining'; device: FoundHandset; ssid: string; text: string }
  | { kind: 'linking'; device: FoundHandset; ssid: string; text: string }
  | { kind: 'done'; device: FoundHandset; ssid: string }
  | { kind: 'failed'; at: FailedAt; text: string; device?: FoundHandset; network?: HandsetNetwork };

export interface ProvisionState {
  step: ProvisionStep;
  /** 手机这会儿连着的 Wi-Fi(知道的话)。只拿来把那一个排到列表最前。 */
  phoneSsid?: string;
}

export type ProvisionEvent =
  | { type: 'found'; devices: readonly FoundHandset[] }
  | { type: 'scanEmpty' }
  | { type: 'scanFailed'; text: string }
  | { type: 'pick'; device: FoundHandset }
  | { type: 'connected' }
  | { type: 'connectFailed'; text: string }
  | { type: 'status'; status: HandsetStatus }
  | { type: 'networks'; list: readonly HandsetNetwork[] }
  | { type: 'rescan' }
  | { type: 'choose'; network: HandsetNetwork }
  | { type: 'submit'; psk: string }
  | { type: 'linkFailed'; text: string }
  | { type: 'lost' }
  | { type: 'retry' }
  | { type: 'back' };

export type ProvisionEffect =
  | ['scan']
  | ['stopScan']
  | ['connect', string]
  | ['send', HandsetCommand]
  | ['link']
  | ['disconnect'];

export interface Stepped {
  state: ProvisionState;
  effects: readonly ProvisionEffect[];
}

export function initialState(phoneSsid?: string): ProvisionState {
  return { step: { kind: 'scanning', found: [] }, ...(phoneSsid === undefined ? {} : { phoneSsid }) };
}

/** 一开始就要做的那件事(组件挂上时跑一次)。 */
export const START_EFFECTS: readonly ProvisionEffect[] = [['scan']];

function at(state: ProvisionState, step: ProvisionStep, effects: readonly ProvisionEffect[] = []): Stepped {
  return { state: { ...state, step }, effects };
}

export function step(state: ProvisionState, event: ProvisionEvent): Stepped {
  const current = state.step;

  // ——— 断线:在哪一步断的决定退回哪里 ———
  if (event.type === 'lost') {
    if (current.kind === 'done' || current.kind === 'failed') return { state, effects: [] };
    return at(state, { kind: 'failed', at: current.kind === 'connecting' ? 'connect' : 'wifi', text: TEXT.lost });
  }

  switch (current.kind) {
    case 'scanning': {
      if (event.type === 'found') return at(state, { kind: 'scanning', found: event.devices });
      if (event.type === 'scanEmpty') return at(state, { kind: 'failed', at: 'scan', text: TEXT.none });
      if (event.type === 'scanFailed') return at(state, { kind: 'failed', at: 'scan', text: event.text });
      if (event.type === 'pick') {
        return at(state, { kind: 'connecting', device: event.device },
          [['stopScan'], ['connect', event.device.id]]);
      }
      return { state, effects: [] };
    }

    case 'connecting': {
      if (event.type === 'connectFailed') {
        return at(state, { kind: 'failed', at: 'connect', text: event.text, device: current.device });
      }
      if (event.type === 'connected') {
        // 连上就先要一遍状态与 Wi-Fi 列表。**两条一起发** —— 座机可能已经连着网了
        // (看门狗轮到了),那时直接跳到下一步,不该让人白选一次 Wi-Fi。
        return at(state, { kind: 'networks', device: current.device, list: [], busy: true },
          [['send', { op: 'status' }], ['send', { op: 'scan' }]]);
      }
      return { state, effects: [] };
    }

    case 'networks': {
      if (event.type === 'networks') {
        return at(state, { kind: 'networks', device: current.device, list: event.list, busy: false });
      }
      if (event.type === 'rescan') {
        return at(state, { kind: 'networks', device: current.device, list: current.list, busy: true },
          [['send', { op: 'scan' }]]);
      }
      if (event.type === 'choose') {
        return at(state, { kind: 'password', device: current.device, network: event.network });
      }
      return { state, effects: [] };
    }

    case 'password': {
      if (event.type === 'back') {
        return at(state, { kind: 'networks', device: current.device, list: [], busy: true },
          [['send', { op: 'scan' }]]);
      }
      if (event.type === 'submit') {
        return at(state, {
          kind: 'joining', device: current.device, ssid: current.network.ssid,
          text: `正在让座机连 ${current.network.ssid}…`,
        }, [['send', { op: 'connect', ssid: current.network.ssid, psk: event.psk }]]);
      }
      return { state, effects: [] };
    }

    case 'joining': {
      if (event.type !== 'status') return { state, effects: [] };
      const status = event.status;
      if (status.phase === 'online' && status.error === '') {
        // 连上了 → **马上进配对那一步**,不等人再点一下。
        // Ben 的六步里「配对进房」是自动发生的,他只看结果。
        return at(state, {
          kind: 'linking', device: current.device, ssid: status.ssid || current.ssid,
          text: '正在把这台座机记到你的账号下…',
        }, [['link']]);
      }
      if (status.error !== '') {
        // 派那边已经写好了人话(「密码不对。重新输一遍试试」),**原样用**。
        return at(state, { kind: 'failed', at: 'wifi', text: status.text, device: current.device });
      }
      return at(state, { ...current, text: status.text || current.text });
    }

    case 'linking': {
      if (event.type === 'linkFailed') {
        return at(state, { kind: 'failed', at: 'link', text: event.text || TEXT.linkFailed, device: current.device });
      }
      if (event.type === 'status') {
        if (event.status.linked) {
          return at(state, { kind: 'done', device: current.device, ssid: event.status.ssid || current.ssid },
            [['disconnect']]);
        }
        if (event.status.error !== '') {
          return at(state, { kind: 'failed', at: 'link', text: event.status.text || TEXT.linkFailed, device: current.device });
        }
      }
      return { state, effects: [] };
    }

    case 'failed': {
      if (event.type !== 'retry') return { state, effects: [] };
      // **「重试」退回哪一步,取决于已经成了哪一半**。
      // 网都配好了还把人打回「找座机」,是这条流程最气人的可能。
      if (current.at === 'scan') return at(state, { kind: 'scanning', found: [] }, [['scan']]);
      if (current.at === 'connect' && current.device !== undefined) {
        return at(state, { kind: 'connecting', device: current.device }, [['connect', current.device.id]]);
      }
      if (current.at === 'wifi' && current.device !== undefined) {
        return at(state, { kind: 'networks', device: current.device, list: [], busy: true },
          [['send', { op: 'scan' }]]);
      }
      if (current.at === 'link' && current.device !== undefined) {
        return at(state, { kind: 'linking', device: current.device, ssid: '', text: TEXT.linkFailed }, [['link']]);
      }
      return at(state, { kind: 'scanning', found: [] }, [['scan']]);
    }

    default:
      return { state, effects: [] };
  }
}

// ———————————————————————— 给界面看的几个小东西 ————————————————————————

/** 这一步的标题。六步各一句,和文档里那六步逐字对得上。 */
export const STEP_TITLE: Record<ProvisionStep['kind'], string> = {
  scanning: '找座机',
  connecting: '连上座机',
  networks: '选 Wi-Fi',
  password: '输密码',
  joining: '正在连',
  linking: '配对进房',
  done: '座机已上线',
  failed: '没成',
};

/** 第几步(1~6),给进度那一行用。失败时显示的是**它卡在第几步**。 */
export function stepIndex(step: ProvisionStep): number {
  switch (step.kind) {
    case 'scanning': return 1;
    case 'connecting': return 1;
    case 'networks': return 2;
    case 'password': return 3;
    case 'joining': return 4;
    case 'linking': return 5;
    case 'done': return 6;
    case 'failed': return step.at === 'scan' ? 1 : step.at === 'connect' ? 1 : step.at === 'wifi' ? 4 : 5;
  }
}

/** 「重试」那颗键上写什么。**说清它会把人送回哪里**。 */
export function retryLabel(at: FailedAt): string {
  switch (at) {
    case 'scan': return '重新找一遍';
    case 'connect': return '再连一次座机';
    case 'wifi': return '换个 Wi-Fi 或重输密码';
    // 卡 HS:说清它重试的是**哪一步** —— 卡在这一步的人刚被告知「网已经配好了」。
    case 'link': return '重试记账号(网不用重配)';
  }
}

/** 列表按「手机连着的排最前」排好。见 provisionProtocol.sortNetworks 的注释。 */
export function orderedNetworks(state: ProvisionState): HandsetNetwork[] {
  if (state.step.kind !== 'networks') return [];
  return sortNetworks(state.step.list, state.phoneSsid);
}
