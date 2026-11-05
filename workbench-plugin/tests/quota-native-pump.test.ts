// @vitest-environment node
/**
 * 2026-09-27(维护者刷新了一次页面:Antigravity 那一格「没接上」,过了一会儿「现在好了」)。
 * 原生那条路的读数只在内存里,重启后要等他切走那家才重读。现在:**组快照时顺手问一次它的本机服务**
 * (只问本机服务,一扇窗都不碰 —— 不会引出幽灵气泡),节流,读过没多久的不重复问。
 */
import { describe, expect, it } from 'vitest'
import { createWindowQuotaReader } from '../src/server/agentQuota.ts'

const FAMILY = { id: 'com.google.antigravity', bundleId: 'com.google.antigravity', title: 'Antigravity' }

describe('原生那条路:起来就问、节流', () => {
  it('★没读过就问一次;60 秒内再泵不重复问;一扇窗都不碰', async () => {
    let t = Date.parse('2026-09-27T05:00:00Z')
    let natives = 0
    let windows = 0
    const r = createWindowQuotaReader({
      request: async () => { windows += 1; return { ok: true, result: { matches: [] } } },
      helper: () => ({ connected: true, authorized: true, readTexts: true }),
      now: () => new Date(t),
      readNative: async (_family: unknown, at: string) => { natives += 1; return { id: FAMILY.id, title: 'Antigravity', state: 'numbers', line: '还剩约 100%', read_at: at } as never },
    } as never)
    r.pumpNative([FAMILY as never])
    await new Promise(res => setTimeout(res, 0))
    expect(natives).toBe(1)
    t += 30_000
    r.pumpNative([FAMILY as never])
    await new Promise(res => setTimeout(res, 0))
    expect(natives).toBe(1)
    t += 4 * 60_000
    r.pumpNative([FAMILY as never])
    await new Promise(res => setTimeout(res, 0))
    expect(natives).toBe(2)
    expect(windows).toBe(0)
  })
})
