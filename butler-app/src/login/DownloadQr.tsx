/**
 * 电脑端获取地址的二维码(2026-09-17 登录指引屏)。手机上显示,用别的设备扫、或者拿给旁边的人扫。
 *
 * 画法与工作台那一份逐字同源(workbench-plugin/src/client/PairQr.tsx):qrcode-generator 2.0.4
 * (纯 JS、零依赖、MIT)算模块矩阵,自己拼一条 SVG path —— 不用它的 createSvgTag,那要 innerHTML。
 * 白底黑块是硬写的:二维码在纯黑主题上反色扫不出来,这一处不跟主题走。
 */
import qrcode from 'qrcode-generator';

export interface QrPath { size: number; d: string }

/** 文本 → 模块矩阵 → 一条 path(每个黑块一个 1×1 的方)。typeNumber 0 = 自动选尺寸,纠错 M。 */
export function qrPath(text: string): QrPath {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }
  return { size, d: parts.join('') };
}

export function DownloadQr({ text, label, px = 168 }: { text: string; label: string; px?: number }) {
  const { size, d } = qrPath(text);
  const margin = 2;
  const box = size + margin * 2;
  return (
    <svg
      className="ba-login__qr"
      role="img"
      aria-label={label}
      width={px}
      height={px}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
    >
      <rect x="0" y="0" width={box} height={box} fill="#ffffff" />
      <path d={d} fill="#000000" transform={`translate(${margin} ${margin})`} />
    </svg>
  );
}
