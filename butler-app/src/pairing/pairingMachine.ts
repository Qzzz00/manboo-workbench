/**
 * 首次配对的状态机(纯函数,界面只是它的投影)。2026-09-16 起以扫码为主:
 *
 *   discovering(首屏:大按钮「扫码配对」+ 后台发现到的列表)
 *     ──scan_start──▶ scanning ──scanned(带 code)──▶ claiming ──▶ paired
 *                        │                                  └──失败──▶ code(带服务端的话)
 *                        └──scan_failed(相机拒绝 / 打不开)──▶ scanning(带原因,同屏给手输路径)
 *   列表 pick / manual_target ──▶ code ──submit 6 位──▶ claiming
 *
 * 局域网发现在后台一直跑,任何阶段的 discovered 都只往列表里记;没找到不跳页、不弹说明。
 * 只有 code 校验(6 位数字)在本地做;码对不对、锁没锁,全听服务端(/pair/claim)的。
 */
import type { Pairing } from '../api/tokenStore';
import { isSixDigitCode, normalizeHostPort, type PairTarget } from './pairUrl';

export interface DiscoveredWorkbench {
  name: string;
  host: string;
  port: number;
  version?: string;
  /** 这台 Mac 的机器 id(局域网 M2 起 TXT 带 `mac_id`):同一个局域网里好几台工作台时,只认配对过的那台。 */
  macId?: string;
}

export type Target = { host: string; port: number };

export type PairingState =
  | { phase: 'discovering'; found: DiscoveredWorkbench[]; done?: boolean }
  | { phase: 'scanning'; found: DiscoveredWorkbench[]; error?: string }
  | { phase: 'manual'; found: DiscoveredWorkbench[]; error?: string }
  | { phase: 'code'; found: DiscoveredWorkbench[]; target: Target; error?: string; lockedUntil?: string }
  | { phase: 'claiming'; found: DiscoveredWorkbench[]; target: Target; code: string }
  | { phase: 'paired'; found: DiscoveredWorkbench[]; pairing: Pairing };

export type PairingEvent =
  | { type: 'discovered'; workbench: DiscoveredWorkbench }
  | { type: 'discovery_done' }
  | { type: 'discovery_unavailable' }
  | { type: 'scan_start' }
  | { type: 'scan_cancel' }
  | { type: 'scan_failed'; error: string }
  | { type: 'pick'; target: Target }
  | { type: 'scanned'; target: PairTarget }
  | { type: 'manual' }
  | { type: 'manual_target'; raw: string }
  | { type: 'submit'; code: string }
  | { type: 'claim_ok'; pairing: Pairing }
  | { type: 'claim_failed'; error: string; lockedUntil?: string }
  | { type: 'back' }
  | { type: 'rediscover' };

export const CODE_FORMAT_ERROR = '配对码是 6 位数字';
export const TARGET_FORMAT_ERROR = '请填工作台的局域网地址,如 192.168.1.8:8791';

export function initialPairing(): PairingState {
  return { phase: 'discovering', found: [] };
}

function sameWorkbench(a: DiscoveredWorkbench, b: DiscoveredWorkbench): boolean {
  return a.host === b.host && a.port === b.port;
}

function home(found: DiscoveredWorkbench[]): PairingState {
  return { phase: 'discovering', found, done: true };
}

export function reducePairing(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case 'discovered': {
      const found = state.found.some((w) => sameWorkbench(w, event.workbench))
        ? state.found.map((w) => (sameWorkbench(w, event.workbench) ? event.workbench : w))
        : [...state.found, event.workbench];
      if (state.phase === 'discovering') return { phase: 'discovering', found, ...(state.done ? { done: true } : {}) };
      return { ...state, found };
    }
    case 'discovery_done':
    case 'discovery_unavailable':
      // 首屏是扫码;找没找到都不跳页、不弹说明(Ben 2026-09-16)。
      if (state.phase !== 'discovering') return state;
      return home(state.found);
    case 'scan_start':
      if (state.phase === 'claiming' || state.phase === 'paired') return state;
      return { phase: 'scanning', found: state.found };
    case 'scan_cancel':
      if (state.phase !== 'scanning') return state;
      return home(state.found);
    case 'scan_failed':
      if (state.phase !== 'scanning') return state;
      return { phase: 'scanning', found: state.found, error: event.error };
    case 'pick':
      return { phase: 'code', found: state.found, target: event.target };
    case 'scanned': {
      const target = { host: event.target.host, port: event.target.port };
      return event.target.code === undefined
        ? { phase: 'code', found: state.found, target }
        : { phase: 'claiming', found: state.found, target, code: event.target.code };
    }
    case 'manual':
      return { phase: 'manual', found: state.found };
    case 'manual_target': {
      if (state.phase !== 'manual') return state;
      const target = normalizeHostPort(event.raw);
      if (target === null) return { ...state, error: TARGET_FORMAT_ERROR };
      return { phase: 'code', found: state.found, target };
    }
    case 'submit': {
      if (state.phase !== 'code') return state;
      if (!isSixDigitCode(event.code)) return { phase: 'code', found: state.found, target: state.target, error: CODE_FORMAT_ERROR };
      return { phase: 'claiming', found: state.found, target: state.target, code: event.code.trim() };
    }
    case 'claim_ok':
      if (state.phase !== 'claiming') return state;
      return { phase: 'paired', found: state.found, pairing: event.pairing };
    case 'claim_failed':
      if (state.phase !== 'claiming') return state;
      return {
        phase: 'code', found: state.found, target: state.target, error: event.error,
        ...(event.lockedUntil === undefined ? {} : { lockedUntil: event.lockedUntil }),
      };
    case 'back':
      if (state.phase === 'code' || state.phase === 'claiming') {
        return state.found.length > 0 ? home(state.found) : { phase: 'manual', found: state.found };
      }
      if (state.phase === 'manual' || state.phase === 'scanning') return home(state.found);
      return state;
    case 'rediscover':
      return initialPairing();
  }
}
