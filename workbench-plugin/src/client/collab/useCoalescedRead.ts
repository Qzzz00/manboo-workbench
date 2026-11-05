/**
 * 跟着快照重读一个口,但**不丢在途的那次**(2026-10-28):`/state` 每秒一份新快照,原来每份都作废上一次读,
 * 回得比 1 秒慢的口(轨迹 2 秒多、执行片段 1.6 秒)永远落不了地,界面一直「在读」。
 *
 * 现在:同一时刻只有一次在途;在途时快照又变了只记一笔,回来后再读一次。回包到了就用,换了口(换目标)的旧回包不用。
 * 读中保留上次读到的,并给出已等了多久,让界面如实说慢在哪。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskView } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'

/** 隔多久即使事项没变也重读一次(运行片段、回执可能先于卡上的字段变)。 */
export const REREAD_EVERY_MS = 30_000

/**
 * 重读的依据:这几件事项的内容(id、状态、更新时刻),外加每 `REREAD_EVERY_MS` 换一格。
 * 不认快照对象本身 —— 它每秒都是新的,认它就会一读完立刻再读,把慢口压成一直在读。
 */
export function tasksReadKey(tasks: readonly TaskView[], nowMs: number): string {
  return `${Math.floor(nowMs / REREAD_EVERY_MS)}#${tasks.map(task => `${task.id}:${task.status}:${task.updated_at}`).join('|')}`
}

export interface CoalescedRead<T> {
  /** 这个口最近一次读到的(读中也留着)。 */
  data?: T
  /** 最近一次读回来了但取不到。 */
  missing: boolean
  loading: boolean
  /** 在途那次已等了多久。 */
  waitedMs: number
}

export function useCoalescedRead<T>(api: CollabApi, path: string | undefined, trigger: unknown, accept: (raw: unknown) => T | undefined): CoalescedRead<T> {
  const [result, setResult] = useState<{ path?: string, data?: T, missing: boolean }>({ missing: false })
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const latest = useRef({ api, path, accept })
  latest.current = { api, path, accept }
  const inFlight = useRef(false)
  const again = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const run = useCallback((): void => {
    const { api: client, path: target } = latest.current
    if (target === undefined) { setStartedAt(undefined); return }
    inFlight.current = true
    again.current = false
    const at = Date.now()
    setStartedAt(at)
    setNow(at)
    void client.get<unknown>(target).then((raw) => {
      inFlight.current = false
      if (!alive.current) return
      const cur = latest.current
      if (cur.path === target) {
        const data = raw === undefined ? undefined : cur.accept(raw)
        setResult(prev => (data === undefined
          ? { path: target, ...(prev.path === target && prev.data !== undefined ? { data: prev.data } : {}), missing: true }
          : { path: target, data, missing: false }))
      }
      if (again.current || cur.path !== target) run()
      else setStartedAt(undefined)
    })
  }, [])

  useEffect(() => {
    if (inFlight.current) again.current = true
    else run()
  }, [path, trigger, run])

  useEffect(() => {
    if (startedAt === undefined) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])

  const mine = result.path === path ? result : { missing: false }
  return {
    ...(mine.data === undefined ? {} : { data: mine.data }),
    missing: mine.missing,
    loading: startedAt !== undefined,
    waitedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
  }
}
