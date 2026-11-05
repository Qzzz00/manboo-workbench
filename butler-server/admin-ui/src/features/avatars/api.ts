// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/api.ts(去 lorebook 与 prompt 预览)
/**
 * Admin 角色管理 API 封装，严格对齐 ALL-143 契约。
 *
 * 关键约定：
 * - 新建上传走 multipart/form-data：meta = JSON.stringify({...})，zip = File。
 * - PATCH 只发送可写字段，数字空值由调用方传 undefined / 省略，不发空串。
 * - 所有失败抛 AdminApiError，code 为契约错误码。
 */

import { request } from '@/shared/api/client';
import type {
  AvatarAdminDetail,
  AvatarAdminSummary,
  AvatarPreviewUrl,
  AvatarStatus,
  ContextTemplate,
  CreateAvatarMeta,
  PatchAvatarPayload,
  ReextractVersionResult,
  RestoreVersionResult,
  UploadVersionResult,
  VoiceBinding,
  VoiceScene,
} from '@/shared/types';

/** GET /admin/avatars?status= */
export async function listAvatars(status?: AvatarStatus): Promise<AvatarAdminSummary[]> {
  const res = await request<{ avatars: AvatarAdminSummary[] }>('/admin/avatars', {
    query: { status },
  });
  return res.avatars;
}

/** GET /admin/avatars/:id */
export async function getAvatar(id: string): Promise<AvatarAdminDetail> {
  const res = await request<{ avatar: AvatarAdminDetail }>(`/admin/avatars/${encodeURIComponent(id)}`);
  return res.avatar;
}

/** PATCH /admin/avatars/:id — payload 仅包含可写且被修改的字段 */
export async function patchAvatar(id: string, payload: PatchAvatarPayload): Promise<AvatarAdminDetail> {
  const res = await request<{ avatar: AvatarAdminDetail }>(`/admin/avatars/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: payload,
  });
  return res.avatar;
}

/** PUT /admin/avatars/:id/voice-bindings/:scene — upsert 一条角色×场景音色绑定 */
export async function putVoiceBinding(
  avatarId: string,
  scene: VoiceScene,
  payload: { providerId: string; voiceId: string; params?: Record<string, unknown> },
): Promise<VoiceBinding> {
  const res = await request<{ binding: VoiceBinding }>(
    `/admin/avatars/${encodeURIComponent(avatarId)}/voice-bindings/${scene}`,
    { method: 'PUT', json: payload },
  );
  return res.binding;
}

/** DELETE /admin/avatars/:id/voice-bindings/:scene — 删除绑定（回到继承/全局默认） */
export async function deleteVoiceBinding(avatarId: string, scene: VoiceScene): Promise<void> {
  await request(`/admin/avatars/${encodeURIComponent(avatarId)}/voice-bindings/${scene}`, { method: 'DELETE' });
}

/** GET /admin/avatars/:id/prompt_template */
export async function getPromptTemplate(id: string): Promise<ContextTemplate | null> {
  const res = await request<{ prompt_template: ContextTemplate | null }>(
    `/admin/avatars/${encodeURIComponent(id)}/prompt_template`,
  );
  return res.prompt_template;
}

/** PUT /admin/avatars/:id/prompt_template */
export async function updatePromptTemplate(
  id: string,
  promptTemplate: ContextTemplate | null,
): Promise<ContextTemplate | null> {
  const res = await request<{ prompt_template: ContextTemplate | null }>(
    `/admin/avatars/${encodeURIComponent(id)}/prompt_template`,
    { method: 'PUT', json: { prompt_template: promptTemplate } },
  );
  return res.prompt_template;
}

/** 构造新建上传的 FormData：meta(JSON 字符串) + zip(File)。单独导出便于单测。 */
export function buildCreateForm(meta: CreateAvatarMeta, zip: File): FormData {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('zip', zip);
  return form;
}

/** POST /admin/avatars （multipart） */
export async function createAvatar(
  meta: CreateAvatarMeta,
  zip: File,
  onProgress?: (percent: number) => void,
): Promise<AvatarAdminDetail> {
  const res = await request<{ avatar: AvatarAdminDetail }>('/admin/avatars', {
    method: 'POST',
    form: buildCreateForm(meta, zip),
    onProgress,
  });
  return res.avatar;
}

/** POST /admin/avatars/backgrounds — 上传背景图，返回客户端可直连的绝对 URL */
export async function uploadBackground(image: File, onProgress?: (percent: number) => void): Promise<string> {
  const form = new FormData();
  form.append('image', image);
  const res = await request<{ url: string }>('/admin/avatars/backgrounds', { method: 'POST', form, onProgress });
  return res.url;
}

/** POST /admin/avatars/portraits — 上传头像图，返回客户端可直连的绝对 URL */
export async function uploadPortrait(image: File, onProgress?: (percent: number) => void): Promise<string> {
  const form = new FormData();
  form.append('image', image);
  const res = await request<{ url: string }>('/admin/avatars/portraits', { method: 'POST', form, onProgress });
  return res.url;
}

/** POST /admin/avatars/audio — 上传来电铃声 / 消息提示音，返回客户端可直连的绝对 URL */
export async function uploadAudio(audio: File, onProgress?: (percent: number) => void): Promise<string> {
  const form = new FormData();
  form.append('audio', audio);
  const res = await request<{ url: string }>('/admin/avatars/audio', { method: 'POST', form, onProgress });
  return res.url;
}

/** POST /admin/avatars/:id/assets — 上传新版本（multipart，仅 zip） */
export async function uploadVersion(
  id: string,
  zip: File,
  onProgress?: (percent: number) => void,
): Promise<UploadVersionResult> {
  const form = new FormData();
  form.append('zip', zip);
  return request<UploadVersionResult>(`/admin/avatars/${encodeURIComponent(id)}/assets`, {
    method: 'POST',
    form,
    onProgress,
  });
}

/** POST /admin/avatars/:id/assets/restore — 从历史版本恢复并生成新版本（历史不删除） */
export async function restoreAvatarVersion(id: string, sourceVersion: number): Promise<RestoreVersionResult> {
  return request<RestoreVersionResult>(`/admin/avatars/${encodeURIComponent(id)}/assets/restore`, {
    method: 'POST',
    json: { source_version: sourceVersion },
  });
}

/** POST /admin/avatars/:id/publish */
export async function publish(id: string): Promise<AvatarAdminSummary> {
  const res = await request<{ avatar: AvatarAdminSummary }>(
    `/admin/avatars/${encodeURIComponent(id)}/publish`,
    { method: 'POST', json: {} },
  );
  return res.avatar;
}

/** POST /admin/avatars/:id/unpublish — 已发布 → draft，角色/版本/历史保留（T1 ALL-589 契约） */
export async function unpublish(id: string): Promise<AvatarAdminSummary> {
  const res = await request<{ avatar: AvatarAdminSummary }>(
    `/admin/avatars/${encodeURIComponent(id)}/unpublish`,
    { method: 'POST', json: {} },
  );
  return res.avatar;
}

/** POST /admin/avatars/:id/archive */
export async function archive(id: string): Promise<AvatarAdminSummary> {
  const res = await request<{ avatar: AvatarAdminSummary }>(
    `/admin/avatars/${encodeURIComponent(id)}/archive`,
    { method: 'POST', json: {} },
  );
  return res.avatar;
}

/** DELETE /admin/avatars/:id — 成功返回 204，无 body */
export async function deleteAvatar(id: string): Promise<void> {
  await request<void>(`/admin/avatars/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /admin/avatars/:id/assets/:version/reextract — 用原 bundle.zip 按当前规则重新解压该版本(修 GBK 乱码文件名;不生成新版本) */
export async function reextractAvatarVersion(id: string, version: number): Promise<ReextractVersionResult> {
  return request<ReextractVersionResult>(
    `/admin/avatars/${encodeURIComponent(id)}/assets/${encodeURIComponent(String(version))}/reextract`,
    { method: 'POST', json: {} },
  );
}

/** GET /admin/avatars/:id/preview-url — 取带签名的预览基址（上传角色）。modelUrl 已逐段 encodeURIComponent。 */
export async function getAvatarPreviewUrl(id: string): Promise<AvatarPreviewUrl> {
  return request<AvatarPreviewUrl>(`/admin/avatars/${encodeURIComponent(id)}/preview-url`);
}
