export function fitDimensions(srcW: number, srcH: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(srcW, srcH);
  if (longest <= maxEdge) return { width: srcW, height: srcH };
  const ratio = maxEdge / longest;
  return { width: Math.round(srcW * ratio), height: Math.round(srcH * ratio) };
}

export type ScaledImage = {
  dataUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
};

/** 用 canvas 把图片文件降采样到最长边 maxEdge，导出为 JPEG data URL。 */
export async function scaleImageFile(
  file: File,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<ScaledImage> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 0.7;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = objectUrl;
    });
    const { width, height } = fitDimensions(img.naturalWidth, img.naturalHeight, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(img, 0, 0, width, height);
    const mimeType = 'image/jpeg';
    const dataUrl = canvas.toDataURL(mimeType, quality);
    // data URL base64 长度 → 估算字节数
    const base64 = dataUrl.split(',')[1] ?? '';
    const sizeBytes = Math.floor((base64.length * 3) / 4);
    return { dataUrl, width, height, sizeBytes, mimeType };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
