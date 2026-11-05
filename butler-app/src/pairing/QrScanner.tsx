/**
 * 站内扫码:getUserMedia 取后摄画面 → 每 200ms 用 jsQR 解一帧。纯本地,不出站、不装 ML Kit。
 * 扫不到就一直扫;用户随时点「取消」。
 * 相机权限被拒 / 打不开 → 调 onError 把原因交给上层(上层同屏给手输 6 位码的路径),这里不自己画错误。
 */
import { useEffect, useRef } from 'react';

export interface QrScannerProps {
  onResult(text: string): void;
  onCancel(): void;
  onError(message: string): void;
}

export const CAMERA_DENIED = '需要相机权限才能扫码';
export const CAMERA_UNAVAILABLE = '打不开相机';

export function QrScanner({ onResult, onCancel, onError }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const canvas = document.createElement('canvas');

    (async () => {
      try {
        const devices = navigator.mediaDevices;
        if (devices === undefined || typeof devices.getUserMedia !== 'function') throw new Error('no mediaDevices');
        stream = await devices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (err) {
        if (done) return;
        const denied = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
        onError(denied ? CAMERA_DENIED : CAMERA_UNAVAILABLE);
        return;
      }
      const video = videoRef.current;
      if (video === null || done) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      const { default: jsQR } = await import('jsqr');
      timer = setInterval(() => {
        if (done || video.videoWidth === 0) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx === null) return;
        ctx.drawImage(video, 0, 0);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (code !== null && code.data !== '') {
          done = true;
          onResult(code.data);
        }
      }, 200);
    })();

    return () => {
      done = true;
      if (timer !== null) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult, onError]);

  return (
    <div className="ba-scan">
      <video ref={videoRef} className="ba-scan__video" playsInline muted />
      <div className="ba-scan__frame" aria-hidden />
      <p className="ba-scan__hint">对准 Mac 工作台设置里的二维码</p>
      <button type="button" className="ba-btn ba-btn--ghost" onClick={onCancel}>取消</button>
    </div>
  );
}
