/**
 * 动态场景背景 · 客户端事务（ALL-414）
 *
 * 服务端是场景/背景的唯一权威来源：lifeSigns.background_id 下发新背景后，
 * 客户端必须先预加载，成功才切换 activeBg，并回传 background-loaded ack
 * （服务端收到 ack 才 commit 场景，角色才允许说“已经到了”）；
 * 预加载/加载失败保留旧背景并回传 ok=false，由服务端决定改口话术，不穿帮。
 */
import { apiPost, getBaseUrl } from './apiClient.ts';

/** lifeSigns.background_id → 可加载 URL：绝对 URL 原样，其余相对路径/裸名按服务器 base 解析。
 *  客户端源是 Capacitor localhost，相对路径会解析到本机导致加载失败，必须拼服务器 baseUrl。 */
export function resolveLifeSignsBackgroundUrl(backgroundId: string): string {
  if (/^https?:\/\//i.test(backgroundId)) return backgroundId;
  const base = getBaseUrl().replace(/\/+$/, '');
  if (backgroundId.startsWith('/')) return `${base}${backgroundId}`;
  return `${base}/backgrounds/${backgroundId}.jpg`;
}

/** 预加载图片：onload/onerror 定成败，超时按失败处理（由调用方决定回退）。 */
export function preloadImage(url: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('background preload timeout'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('background preload failed'));
    };
    img.src = url;
  });
}

export interface SceneBackgroundAck {
  scene_key?: string;
  background_url?: string;
  ok: boolean;
}

/** 回传背景加载结果。ack 失败只记日志：画面状态留在服务端，下次切换自愈。 */
export async function ackSceneBackground(avatarId: string, payload: SceneBackgroundAck): Promise<void> {
  try {
    await apiPost(
      `/api/sessions/${encodeURIComponent(avatarId)}/journey/background-loaded`,
      payload,
    );
  } catch (err) {
    console.warn('[scene-background] ack failed:', err);
  }
}

export interface ApplyLifeSignsBackgroundArgs {
  avatarId: string;
  /** lifeSigns.background_id（服务端下发的场景背景） */
  backgroundId: string;
  sceneKey?: string;
  currentBg: string | null;
  setBackground: (url: string) => void;
  /** 测试注入点：默认真实预加载/回传 */
  preload?: (url: string) => Promise<void>;
  ack?: (avatarId: string, payload: SceneBackgroundAck) => Promise<void>;
}

/**
 * 处理一次服务端背景下发：与当前相同则跳过（兼作 ack 循环断路器）；
 * 预加载成功 → 切换 + ack(ok)；失败 → 保留旧背景 + ack(fail)。
 */
export async function applyLifeSignsBackground(
  args: ApplyLifeSignsBackgroundArgs,
): Promise<'applied' | 'skipped' | 'failed'> {
  const {
    avatarId,
    backgroundId,
    sceneKey,
    currentBg,
    setBackground,
    preload = preloadImage,
    ack = ackSceneBackground,
  } = args;

  if (!backgroundId) return 'skipped';
  const url = resolveLifeSignsBackgroundUrl(backgroundId);
  if (url === currentBg) return 'skipped';

  // ack 只是状态回传，任何失败都不影响画面决策。
  const safeAck = async (ok: boolean) => {
    try {
      await ack(avatarId, { scene_key: sceneKey, background_url: url, ok });
    } catch (err) {
      console.warn('[scene-background] ack error (swallowed):', err);
    }
  };

  try {
    await preload(url);
  } catch (err) {
    console.warn('[scene-background] preload failed, keep old background:', err);
    await safeAck(false);
    return 'failed';
  }
  setBackground(url);
  await safeAck(true);
  return 'applied';
}
