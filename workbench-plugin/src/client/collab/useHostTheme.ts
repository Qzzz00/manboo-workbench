/**
 * 协作区跟着宿主(DSH)的明暗走:读宿主的底色令牌 `--dsw-alias-bg-base`,亮度过半就是亮版。
 * 读不到(用例、老宿主)按暗版 —— 工作台本来就是黑底。宿主换主题时 class / style 会变,用 MutationObserver 跟。
 */
import { useEffect, useState, type RefObject } from 'react'

export type HostTheme = 'dark' | 'light'

/** `#rrggbb` / `rgb(r, g, b)` → 亮度 0–1;认不出回 undefined。 */
export function luminanceOf(color: string): number | undefined {
  const text = color.trim()
  let rgb: number[] | undefined
  const hex = /^#([0-9a-f]{6})$/i.exec(text)
  if (hex !== null) rgb = [0, 2, 4].map(at => parseInt((hex[1] as string).slice(at, at + 2), 16))
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(text)
  if (fn !== null) rgb = [fn[1], fn[2], fn[3]].map(one => Number(one))
  if (rgb === undefined) return undefined
  const [r, g, b] = rgb as [number, number, number]
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

export function themeOf(color: string): HostTheme {
  const l = luminanceOf(color)
  return l !== undefined && l > 0.5 ? 'light' : 'dark'
}

export function useHostTheme(ref: RefObject<HTMLElement>): HostTheme {
  const [theme, setTheme] = useState<HostTheme>('dark')
  useEffect(() => {
    const read = (): void => {
      const el = ref.current
      if (el === null || typeof getComputedStyle === 'undefined') return
      const host = el.parentElement ?? el
      setTheme(themeOf(getComputedStyle(host).getPropertyValue('--dsw-alias-bg-base')))
    }
    read()
    if (typeof MutationObserver === 'undefined') return undefined
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => observer.disconnect()
  }, [ref])
  return theme
}
