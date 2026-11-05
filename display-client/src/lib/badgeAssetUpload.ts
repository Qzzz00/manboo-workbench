/* 吧唧素材上传（决策 A1 后端中转的 App 侧）：.abp + 证书元数据 POST 给后端，
 * 后端存储并绑定设备，吧唧固件 P2 经 WiFi 拉取（GET /badge/assets/:deviceId/latest）。
 *
 * 环境路由：浏览器 dev = 相对路径（vite badgeAssetSink 中间件落盘 badge-assets/uploads/，
 * 全流程本地可验）；原生 App / 生产 = apiFetch（云端 baseUrl + Bearer token，路由代码
 * server/routes/badge-assets.cjs 挂在 server.cjs 全局 json 解析器之前以启用 32mb 限额）。
 */
import { ApiAuthError, ApiError, apiFetch, isBrowserDev } from './apiClient.ts';

export type BadgeAssetMeta = {
  avatarId: string;
  fps: number;
  frameCount: number;
  certificate: {
    pass: boolean;
    residual: number;
    wrapMad: number;
    medianMad: number;
    warmupCycles: number;
    warnings: string[];
  };
};

export type BadgeAssetUploadResult =
  | { ok: true; assetId: string }
  | { ok: false; error: string };

function bytesToBase64(bytes: Uint8Array): string {
  // 分块避免 String.fromCharCode 参数上限（.abp ~1-5MB）
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

type UploadResponse = { ok?: boolean; assetId?: string; error?: string };

function toResult(data: UploadResponse): BadgeAssetUploadResult {
  if (!data.ok || !data.assetId) return { ok: false, error: data.error ?? '后端返回异常' };
  return { ok: true, assetId: data.assetId };
}

export async function uploadBadgeAsset(abp: Uint8Array, meta: BadgeAssetMeta, deviceId = 'default'): Promise<BadgeAssetUploadResult> {
  const body = JSON.stringify({ deviceId, meta, abpBase64: bytesToBase64(abp) });
  try {
    // 浏览器 dev：vite badgeAssetSink 中间件（同源落盘，无鉴权）。
    // 真机/生产：apiFetch（云端 baseUrl + Bearer token + 超时）。曾用裸 isLocalDevHost
    // 分支——原生 WebView(http://localhost) 被误判成 dev，上传打回 App 自己收到 SPA 的
    // <!doctype（2026-07-10 实锤）；判定语义见 apiClient.isBrowserDev。
    if (isBrowserDev()) {
      const res = await fetch('/badge/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return toResult((await res.json()) as UploadResponse);
    }
    // .abp base64 可达数 MB，手机上行慢：超时放宽到 180s（默认 60s 不够）
    const data = await apiFetch('/badge/assets', { method: 'POST', body, timeoutMs: 180000 });
    return toResult(data as UploadResponse);
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return { ok: false, error: '投放需要登录（游客没有云端身份）——先去个人主页登录，再回来点投放' };
    }
    if (error instanceof ApiError) {
      return { ok: false, error: `${error.message}（HTTP ${error.status}）` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
