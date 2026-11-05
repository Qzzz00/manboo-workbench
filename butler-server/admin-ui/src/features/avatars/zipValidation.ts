// 来源:Aiboo origin/main 1f430c3f admin-ui/src/features/avatars/zipValidation.ts
/** 前端 zip 校验：扩展名 .zip + 大小 <= 100MB（对齐契约 upload_too_large / avatar_zip_invalid）。 */

export const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100MB

export interface ZipCheckResult {
  ok: boolean;
  /** 失败时的用户可见文案 */
  message?: string;
  /** 对齐契约错误码，便于与后端语义一致 */
  code?: 'avatar_zip_invalid' | 'upload_too_large';
}

export function validateZipFile(file: File | null | undefined): ZipCheckResult {
  if (!file) {
    return { ok: false, message: '请先选择 .zip 文件', code: 'avatar_zip_invalid' };
  }
  const isZipExt = /\.zip$/i.test(file.name);
  const isZipMime = file.type === '' || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
  if (!isZipExt || !isZipMime) {
    return { ok: false, message: '只支持 .zip 压缩包', code: 'avatar_zip_invalid' };
  }
  if (file.size > MAX_ZIP_BYTES) {
    return { ok: false, message: '压缩包超过 100MB 上限', code: 'upload_too_large' };
  }
  if (file.size === 0) {
    return { ok: false, message: '压缩包内容为空', code: 'avatar_zip_invalid' };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
