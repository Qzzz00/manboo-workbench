/**
 * 引导流程的接口(契约见 docs/交接-0915-引导流程后端.md 与 docs/交接-0916-手机粒子共用配置与引导走通.md):
 *   GET  /onboarding                → 全貌(stage / done / plan / answered / recap / askedAt / session_id)
 *   POST /onboarding/session        → 开(或续)引导会话;{ session_id } 或 { note:'会话未开' };已完成 409
 *   POST /onboarding/say { text }   → 把用户的一句话排进引导会话;会话没开 / 已结束 409(重新 session)
 *   GET  /onboarding/turns?after=   → 引导回合(user / assistant 文本)+ busy / ended / stage / done
 *   POST /onboarding/restart        → { scope:'all' } 从头来
 * 阶段推进由后端做,手机只显示。
 */
import type { ApiClient, ApiResult } from '../api/client';
import type { ScanWire } from './scanHold';

export interface OnboardingDetail {
  stage: string;
  done: boolean;
  mode?: string;
  nickname?: string;
  plan: readonly string[];
  answered: Record<string, string[]>;
  next?: { label: string; seed: string; goals: readonly string[]; keys: string[] };
  recap?: string;
  askedAt?: string;
  session_id?: string;
}

/** seed / resumed 是 2026-09-16 开场体验加的:老工作台没有,手机退回全貌里的 next.seed。 */
export type SessionResult =
  | { ok: true; stage: string; session_id: string; first_message: string; seed?: string; resumed?: boolean }
  | { ok: true; stage: string; note: string; first_message: string; seed?: string; resumed?: boolean };

export interface OnboardingTurn {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** 工作台标的:这条是模型照念的当前阶段种子句(手机已经自己显示过,合并)。 */
  kind?: 'seed';
}

export interface TurnsResult {
  turns: OnboardingTurn[];
  session_id?: string;
  busy: boolean;
  ended: boolean;
  stage: string;
  done: boolean;
  /** 当前阶段的种子句(done 时没有)。 */
  seed?: string;
  /**
   * 扫描进度(2026-09-23 服务端加;只报引导里她主动发起的那一次)。老工作台缺席 = 没给信号。
   * 界面按 scanHold.ts scanProgressOf 读。
   */
  scan?: ScanWire;
}

export interface OnboardingApi {
  detail(): Promise<ApiResult<OnboardingDetail>>;
  session(): Promise<ApiResult<SessionResult>>;
  say(text: string): Promise<ApiResult<{ ok: true; session_id: string }>>;
  turns(after: number): Promise<ApiResult<TurnsResult>>;
  restart(scope: 'all' | 'persona' | 'authorization'): Promise<ApiResult<{ ok: true; stage: string }>>;
  /**
   * 换一个主导方(2026-09-18,Ben:「如果手机已经扫码,优先手机的引导流程」)。
   * 手机上那颗「改回手机」按它。**只改界面归属**,阶段与答案一个字不动。
   */
  leader(leader: 'phone' | 'desktop'): Promise<ApiResult<{ ok: true; leader: string }>>;
}

export function createOnboardingApi(client: ApiClient): OnboardingApi {
  return {
    detail: () => client.json<OnboardingDetail>('/onboarding'),
    session: () => client.json<SessionResult>('/onboarding/session', { method: 'POST', body: {} }),
    say: (text) => client.json<{ ok: true; session_id: string }>('/onboarding/say', { method: 'POST', body: { text } }),
    turns: (after) => client.json<TurnsResult>(`/onboarding/turns?after=${encodeURIComponent(String(after))}`),
    restart: (scope) => client.json<{ ok: true; stage: string }>('/onboarding/restart', { method: 'POST', body: { scope } }),
    leader: (leader) => client.json<{ ok: true; leader: string }>('/onboarding/leader', { method: 'POST', body: { leader } }),
  };
}

/** 阶段 → 显示名(与服务端 STAGE_LABEL 同词)。 */
export const STAGE_TITLES: Record<string, string> = {
  opening: '① 开场',
  // 2026-09-21(布局模板):引导多了一步 ①′,在开场与分岔之间。手机这一份是**独立副本**
  // (phone 不 import 插件的源码),服务端 STAGE_LABEL 加一条,这里就要跟着加一条 ——
  // 不加的话进度条上那一格显示的是裸 id `template`(stageTitle 的兜底是"原样回 id")。
  // 手机上的名字比电脑上那份短一点:小屏上「①′ 布局(做产品 / 自媒体运营)」会折行。
  template: '①′ 布局',
  branch: '② 分岔',
  projects: '②′ 项目',
  authorization: '③ 授权',
  habits: '④ 习惯偏好',
  persona: '④′ 对话预期',
  naming: '④″ 取名',
  wrapup: '⑤ 收尾',
  done: '完成',
};
