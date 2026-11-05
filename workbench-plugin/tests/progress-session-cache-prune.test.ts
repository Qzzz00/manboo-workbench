// @vitest-environment node
/**
 * 进度证据的会话缓存要收(2026-10-19,卡「插件内存增长与 GC 抖动」):它按会话文件路径存整条会话的回合文字,
 * 从前只进不出。钉的是:这一轮碰到的一条不丢;别的按进表顺序从最老的丢;收到上限以内;没超不动。
 */
import { describe, expect, it } from 'vitest'
import { pruneSessionCache, SESSION_CACHE_MAX, type SessionCache, type SessionRead } from '../src/server/progressSources.ts'

function read(n: number): SessionRead {
  return { size: n, turns: [{ role: 'him', text: `第 ${n} 条`, at: '2026-10-19T00:00:00.000Z' }] } as unknown as SessionRead
}

function cacheOf(count: number): SessionCache {
  const cache: SessionCache = new Map()
  for (let i = 0; i < count; i += 1) cache.set(`/s/${i}.jsonl`, read(i))
  return cache
}

describe('pruneSessionCache', () => {
  it('没超上限:一条不动,回 0', () => {
    const cache = cacheOf(SESSION_CACHE_MAX)
    expect(pruneSessionCache(cache, new Set())).toBe(0)
    expect(cache.size).toBe(SESSION_CACHE_MAX)
  })

  it('超了:这一轮碰到的留着,别的按最老进表的先丢,收到上限', () => {
    const cache = cacheOf(SESSION_CACHE_MAX + 10)
    const touched = new Set(['/s/0.jsonl', '/s/1.jsonl'])
    const dropped = pruneSessionCache(cache, touched)
    expect(dropped).toBe(10)
    expect(cache.size).toBe(SESSION_CACHE_MAX)
    expect(cache.has('/s/0.jsonl')).toBe(true)
    expect(cache.has('/s/1.jsonl')).toBe(true)
    // 2…11 是最老的没碰到的那十条。
    expect(cache.has('/s/2.jsonl')).toBe(false)
    expect(cache.has('/s/11.jsonl')).toBe(false)
    expect(cache.has('/s/12.jsonl')).toBe(true)
  })

  it('碰到的比上限还多:一条都不丢(宁可多留,不丢这一轮的证据)', () => {
    const cache = cacheOf(5)
    const touched = new Set([...cache.keys()])
    expect(pruneSessionCache(cache, touched, 3)).toBe(0)
    expect(cache.size).toBe(5)
  })
})
