/**
 * 把一段 CSS 里偏紫的写死色值换成同亮度的灰(2026-10-21 协作区)。
 *
 * 用处只有一个:React Flow 自带的基础样式里有几个带一点紫的灰(`#b1b1b7`、`#91919a`、`rgba(150,150,180,…)`),
 * 而工作台的规矩是客户端里除了 Kimi 的家族色一个紫都没有(`tests/client-ops-no-purple-20261013.test.ts`)。
 * 抄进来时过一遍这个,比对那条用例也拿同一个函数比 —— 规矩只写一处。
 */

/** 偏紫 = 色相落在 230°–300°,而且三个通道差得超过 2/255(再少就是灰)。与那条用例同一口径。 */
function tinted(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  if (span <= 2) return false
  const raw = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  const hue = (Math.round(raw * 60) + 360) % 360
  return hue >= 230 && hue <= 300
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

export function neutralizeTintedLiterals(css: string): string {
  return css
    .replace(/#([0-9a-fA-F]{6})\b/g, (whole, digits: string) => {
      const [r, g, b] = [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number]
      if (!tinted(r, g, b)) return whole
      const grey = Math.round((r + g + b) / 3)
      return `#${hex2(grey)}${hex2(grey)}${hex2(grey)}`
    })
    .replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,[^)]*)?\)/g, (whole, rs: string, gs: string, bs: string, alpha: string | undefined) => {
      const [r, g, b] = [rs, gs, bs].map(one => Number.parseInt(one, 10)) as [number, number, number]
      if (!tinted(r, g, b)) return whole
      const grey = Math.round((r + g + b) / 3)
      return alpha === undefined ? `rgb(${grey}, ${grey}, ${grey})` : `rgba(${grey}, ${grey}, ${grey}${alpha})`
    })
}
