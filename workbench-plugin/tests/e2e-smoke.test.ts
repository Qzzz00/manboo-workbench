// @vitest-environment node
/** 端到端冒烟：服务真的起得来、外部 HTTP 真的打得进去、C1 真的保底。 */
import { describe, expect, it } from 'vitest'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'

describe('端到端冒烟', () => {
  it('起服务 → 模拟 hook 上报 → 读快照 → 上游掉线仍有数据', async () => {
    const service = createWorkbenchService()
    const s = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0 })
    try {
      const posted = await fetch(`${s.url}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: 'claude',
          session_id: '3f9e',
          cwd: '/Users/example/Documents/GitHub/desktop-workbench',
          type: 'waiting',
          reason: 'permission_prompt',
          title: '要改 config/schema.ts',
          summary: '改动会影响 3 处引用',
        }),
      })
      expect(posted.status).toBe(200)

      const state = await (await fetch(`${s.url}/state`)).json()
      expect(state.sessions).toHaveLength(1)
      expect(state.sessions[0].project).toBe('desktop-workbench')
      expect(state.stale).toBe(false)

      service.markUpstreamOffline()
      const after = await (await fetch(`${s.url}/state`)).json()
      expect(after.stale).toBe(true)
      expect(after.sessions).toHaveLength(1)

      const bad = await fetch(`${s.url}/event`, { method: 'POST', body: '{坏json' })
      expect(bad.status).toBe(400)
    } finally {
      await s.close()
    }
  })
})
