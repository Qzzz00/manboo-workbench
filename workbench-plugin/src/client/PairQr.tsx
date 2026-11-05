/**
 * 配对二维码(2026-09-11 手机配对)。内容是服务端拼好的 `workbench://pair?...`,这里只画。
 *
 * 用 qrcode-generator 2.0.4(纯 JS、零依赖、MIT,随 client bundle 打进 lib/client.js)算模块矩阵,
 * 自己拼成一条 SVG path——不用它的 createSvgTag,那要 innerHTML。
 */
import qrcode from 'qrcode-generator'

export interface QrPath { size: number, d: string }

/** 把文本编成 QR 模块矩阵,再压成一条 path(每个黑块一个 1×1 的方)。typeNumber 0 = 自动选尺寸,纠错 M。 */
export function qrPath(text: string): QrPath {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const parts: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`)
    }
  }
  return { size, d: parts.join('') }
}

export function PairQr({ text, px = 168 }: { text: string, px?: number }) {
  const { size, d } = qrPath(text)
  const margin = 2
  const box = size + margin * 2
  return (
    <svg
      role="img"
      aria-label="配对二维码"
      width={px}
      height={px}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 6 }}
    >
      <path d={d} fill="#000" transform={`translate(${margin} ${margin})`} />
    </svg>
  )
}
