import {
  apiFetch as baseApiFetch,
  apiGet,
  apiPost,
  apiPatch,
  getStoredToken,
  clearAuth as clearApiAuth,
  getBaseUrl,
  setBaseUrl,
  setTokenRefreshHandler,
  ApiAuthError,
  ApiError,
} from './apiClient.ts';
import {
  API_AUTH_LOGIN,
  API_AUTH_REGISTER,
  API_AUTH_REFRESH,
  API_AUTH_CONFIG,
  API_USER_PROFILE,
} from './apiConfig.ts';

export type UserInfo = {
  id: number;
  username: string;
  avatar: string;
  nickname: string;
  gender: string;
  signature: string;
  birth_date?: string | null;
};

const USER_KEY = 'llm-live2d:user';
const REFRESH_TOKEN_KEY = 'llm-live2d:refresh-token';
const LOCAL_GUEST_KEY = 'llm-live2d:local-guest';

/** 纯本地游客（不连后端，用于本地服务挂掉时进主页调 UI） */
const LOCAL_GUEST_USER: UserInfo = {
  id: -1,
  username: '游客',
  avatar: '🐾',
  nickname: '游客',
  gender: '',
  signature: '本地游客模式',
};

/** 是否处于纯本地游客模式 */
export function isLocalGuest(): boolean {
  try {
    return localStorage.getItem(LOCAL_GUEST_KEY) === '1';
  } catch {
    return false;
  }
}

/** 进入纯本地游客模式（不发任何网络请求），返回本地游客用户 */
export function loginAsLocalGuest(): UserInfo {
  try {
    localStorage.setItem(LOCAL_GUEST_KEY, '1');
    localStorage.setItem(USER_KEY, JSON.stringify(LOCAL_GUEST_USER));
  } catch { /* ignore */ }
  return LOCAL_GUEST_USER;
}

/** 兼容旧接口，保留 setServerUrl 名称 */
export { setBaseUrl as setServerUrl, getBaseUrl as getServerUrl };

/** 兼容旧接口，保留 getStoredToken 名称 */
export { getStoredToken };

/** 复用 apiClient 的 fetch，供直接调用 */
export { ApiAuthError };
export const apiFetch = baseApiFetch;

export function getStoredUser(): UserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserInfo) : null;
  } catch {
    return null;
  }
}

export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveAuth(token: string, refreshToken: string, user: UserInfo) {
  localStorage.setItem('llm-live2d:auth-token', token);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  clearApiAuth();
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(LOCAL_GUEST_KEY);
  } catch { /* ignore */ }
}

export async function loginUser(username: string, password: string): Promise<UserInfo> {
  const data = (await apiPost(API_AUTH_LOGIN, { username, password }, {
    skipAuthHandler: true,
  })) as { token: string; refreshToken: string; user: UserInfo };
  saveAuth(data.token, data.refreshToken, data.user);
  return data.user;
}

export async function registerUser(username: string, password: string, inviteCode?: string): Promise<UserInfo> {
  const data = (await apiPost(API_AUTH_REGISTER, { username, password, inviteCode }, {
    skipAuthHandler: true,
  })) as { token: string; refreshToken: string; user: UserInfo };
  saveAuth(data.token, data.refreshToken, data.user);
  return data.user;
}

/** 内测开关等公开配置（无需登录）。用于登录页决定是否要求邀请码。 */
export async function getAuthConfig(): Promise<{ inviteOnly: boolean }> {
  try {
    const data = (await apiGet(API_AUTH_CONFIG, { skipAuthHandler: true })) as { inviteOnly?: boolean };
    return { inviteOnly: !!data.inviteOnly };
  } catch {
    // 拿不到时按内测处理，避免误开放注册入口。
    return { inviteOnly: true };
  }
}

const GUEST_CRED_KEY = 'llm-live2d:guest-cred';

type GuestCred = { username: string; password: string };

function readGuestCred(): GuestCred | null {
  try {
    const raw = localStorage.getItem(GUEST_CRED_KEY);
    return raw ? (JSON.parse(raw) as GuestCred) : null;
  } catch {
    return null;
  }
}

function saveGuestCred(cred: GuestCred) {
  try {
    localStorage.setItem(GUEST_CRED_KEY, JSON.stringify(cred));
  } catch { /* ignore */ }
}

/**
 * 注册即登录：先尝试注册；若用户名已存在（409）则改为登录。
 * 用于"手机号(=用户名) + 验证码(=密码)"的单按钮流程。
 */
export async function registerOrLogin(username: string, password: string, inviteCode?: string): Promise<UserInfo> {
  try {
    return await registerUser(username, password, inviteCode);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // 已注册用户：直接登录（设备校验在登录侧进行）。
      return await loginUser(username, password);
    }
    throw e;
  }
}

/**
 * 游客/快速登录：本设备复用同一组随机凭证。
 * 首次自动注册并存储，后续直接登录；凭证失效时重新注册。
 */
export async function guestLogin(): Promise<UserInfo> {
  const existing = readGuestCred();
  if (existing) {
    try {
      return await loginUser(existing.username, existing.password);
    } catch {
      // 凭证失效（例如换了后端/数据库被清），落到下面重新注册
    }
  }
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const cred: GuestCred = { username: `guest_${suffix}`, password: Math.random().toString(36).slice(2, 12) };
  const user = await registerUser(cred.username, cred.password);
  saveGuestCred(cred);
  return user;
}

export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return null;
  try {
    const data = (await apiPost(API_AUTH_REFRESH, { refreshToken }, {
      skipAuthHandler: true,
    })) as { token: string; refreshToken: string; user: UserInfo };
    saveAuth(data.token, data.refreshToken, data.user);
    return data.token;
  } catch {
    clearAuth();
    return null;
  }
}

// 注册给 apiClient：任意请求遇 401（access token 过期）时先用 refresh token 静默换新
// access token 并重试，避免会话中途被强制登出。本地游客无 refresh token → 返回 null 照常登出。
setTokenRefreshHandler(() => (isLocalGuest() ? Promise.resolve(null) : refreshAccessToken()));

export async function updateProfile(
  patch: Partial<Pick<UserInfo, 'nickname' | 'gender' | 'avatar' | 'signature' | 'birth_date'>>,
): Promise<UserInfo> {
  const data = (await apiPatch(API_USER_PROFILE, patch)) as { user: UserInfo };
  const user = data.user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export function isTokenValid(): boolean {
  const token = getStoredToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export async function autoLogin(): Promise<UserInfo | null> {
  // 纯本地游客模式：直接返回本地用户，跳过任何后端校验
  if (isLocalGuest()) {
    return getStoredUser() ?? LOCAL_GUEST_USER;
  }
  if (!isTokenValid()) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      clearAuth();
      return null;
    }
  }
  const user = getStoredUser();
  if (user) return user;
  try {
    const data = (await apiGet(API_USER_PROFILE)) as { user: UserInfo };
    const fetchedUser = data.user;
    localStorage.setItem(USER_KEY, JSON.stringify(fetchedUser));
    return fetchedUser;
  } catch (e) {
    // 401 已由 apiClient 自动清掉登录态并触发 handler，这里只需返回 null
    if (e instanceof ApiAuthError) {
      return null;
    }
    clearAuth();
    return null;
  }
}

export function logout() {
  clearAuth();
}
