/**
 * U3 电台鉴权。电台无登录墙，但 /ai/asr、/ai/chat、/ai/tts 都过 authMiddleware，语音全链路（ASR/对话/控制，
 * 含本地关键词快路径——快路径吃的是 ASR 转写文本）都需要有效 token；仅屏幕上的手动播放器控件不依赖云端。
 *
 * 账号**只从本机读**（localStorage `RADIO_ACCOUNT_KEY`，JSON `{ username, password, inviteCode? }`），
 * 源码里不带任何账号。没配就不登录：已有有效 token（authStore 存在 localStorage，401 走既有 refresh token
 * 静默续期）照用，没有就只剩手动播放器。正式需换设备级鉴权（badge/holo 的 pair 机制或轻量登录）。
 */
import { isTokenValid, registerOrLogin } from '../lib/authStore.ts';

export const RADIO_ACCOUNT_KEY = 'aiboo:radio-account';

export interface RadioAccount {
  username: string;
  password: string;
  inviteCode?: string;
}

/** 本机配的那个账号；没配或写坏了是 undefined。 */
export function radioAccount(): RadioAccount | undefined {
  let raw: unknown;
  try {
    const text = localStorage.getItem(RADIO_ACCOUNT_KEY);
    raw = text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { username, password, inviteCode } = raw as Record<string, unknown>;
  if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '') return undefined;
  return { username, password, ...(typeof inviteCode === 'string' && inviteCode !== '' ? { inviteCode } : {}) };
}

let ensured: Promise<void> | null = null;

/**
 * 幂等：已有有效 token 直接返回；否则用本机配的账号注册即登录（首启用邀请码注册，账号已存在则 409→登录）。
 * 失败或没配仅告警不抛（不阻塞电台启动；手动播放器控件仍可用）。
 */
export function ensureRadioAuth(): Promise<void> {
  if (ensured) return ensured;
  ensured = (async () => {
    if (isTokenValid()) return;
    const account = radioAccount();
    if (account === undefined) {
      console.warn(`[radio-auth] 本机没配电台账号（localStorage ${RADIO_ACCOUNT_KEY}），语音全链路不可用，仅手动播放器控件可用`);
      return;
    }
    try {
      await registerOrLogin(account.username, account.password, account.inviteCode);
      console.log('[radio-auth] account ready (registerOrLogin)');
    } catch (e) {
      console.warn('[radio-auth] auth failed (语音全链路不可用，仅手动播放器控件可用):', e);
    }
  })();
  return ensured;
}
