import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

type Section = 'members' | 'filters' | 'waiting' | 'stats' | 'conditions'
type Folds = Record<Section, boolean>
const KEY = 'workbench.collab.context-folds.v1'
/**
 * 统计与能力条件缺省收起(2026-10-27,合并稿 2.1):目标条已经回答完成程度与未完原因,两块再摊开就把事项挤没了。
 * 点开照旧在;存过偏好的按他存的。
 */
const DEFAULTS: Folds = { members: false, filters: false, waiting: false, stats: true, conditions: true }

/** 只保存阅读偏好，不与目标、筛选或业务账绑定；存储受限不妨碍本轮操作。 */
export function useContextFolds(root: RefObject<HTMLElement>) {
  const [folds, setFolds] = useState<Folds>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
      const next = { ...DEFAULTS }
      if (stored !== null && typeof stored === 'object') {
        for (const key of Object.keys(next) as Section[]) {
          const value = (stored as Record<string, unknown>)[key]
          if (typeof value === 'boolean') next[key] = value
        }
      }
      return next
    } catch { return { ...DEFAULTS } }
  })
  const position = useRef<{ desired: number, actual: number }>()
  const update = (next: Folds) => {
    const reading = root.current?.querySelector('.ben-cl__reading')
    if (reading !== null && reading !== undefined) {
      // 视口变大时浏览器可能把靠底部的位置夹到新上限，展开后仍恢复原阅读处。
      if (position.current === undefined || reading.scrollTop !== position.current.actual) {
        position.current = { desired: reading.scrollTop, actual: reading.scrollTop }
      }
    }
    setFolds(next)
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 当前会话仍可用。 */ }
  }
  useLayoutEffect(() => {
    const reading = root.current?.querySelector('.ben-cl__reading')
    if (reading !== null && reading !== undefined && position.current !== undefined) {
      reading.scrollTop = position.current.desired
      position.current.actual = reading.scrollTop
    }
  }, [folds, root])
  return {
    folds,
    toggleFold: (key: Section) => update({ ...folds, [key]: !folds[key] }),
    toggleAll: () => {
      const collapse = !Object.values(folds).every(Boolean)
      update(Object.fromEntries(Object.keys(folds).map(key => [key, collapse])) as Folds)
    },
  }
}
