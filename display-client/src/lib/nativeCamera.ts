import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

/** 是否运行在原生壳里（Android/iOS）。Web 端返回 false，调用方走 <input> 降级。 */
export function isNativeCamera(): boolean {
  return Capacitor.isNativePlatform();
}

/** 用户主动取消拍照/选图——不当作错误处理。 */
export function isCancel(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return msg.includes('cancel');
}

/** Camera 返回的 webPath(WebView 可加载的 url) → File，喂给现有上传链路。 */
async function uriToFile(webPath: string | undefined, baseName: string): Promise<File | null> {
  if (!webPath) return null;
  const resp = await fetch(webPath);
  const blob = await resp.blob();
  const type = blob.type || 'image/jpeg';
  const ext = type.split('/')[1]?.split('+')[0] || 'jpg';
  return new File([blob], `${baseName}.${ext}`, { type });
}

/** 拉起系统相机拍照（首次会弹 CAMERA 权限申请）。取消时抛错，由调用方用 isCancel 区分。 */
export async function takePhoto(): Promise<File | null> {
  const photo = await Camera.getPhoto({
    source: CameraSource.Camera,
    resultType: CameraResultType.Uri,
    quality: 85,
    allowEditing: false,
    saveToGallery: false,
    correctOrientation: true,
  });
  return uriToFile(photo.webPath, `camera-${Date.now()}`);
}
