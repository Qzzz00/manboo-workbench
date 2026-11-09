// @vitest-environment node
/**
 * 「多人协作区」总开关(2026-11-09):这一份钉死两件事 ——
 *   ① 取值规矩:没配 = 关、环境变量优先、app.json 兜底、脏值不当真;
 *   ② 真的关得掉:关着时 /state 如实说 false,/collab/* 与 /token/personal* 一条都不接。
 *
 * 同时钉住兼容位:老宿主 / 单测不传这一格时行为与改动前一致(开),免得哪天有人把缺省值顺手翻了。
 */
import { describe, expect, it } from 'vitest'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { collabFeatureOf } from '../src/collabFeature.ts'

async function withServer(
  collabEnabled: boolean | undefined,
  check: (url: string) => Promise<void>,
): Promise<void> {
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    ...(collabEnabled === undefined ? {} : { collabEnabled }),
  })
  try { await check(server.url) }
  finally { await server.close() }
}

describe('多人协作区总开关 · 取值', () => {
  it('没配 = 关(开源版开箱不接这一整块)', () => {
    expect(collabFeatureOf()).toBe(false)
    expect(collabFeatureOf({})).toBe(false)
  })

  it('app.json 写了 true 才开;写坏 / 写成字符串一律当没配 = 关', () => {
    expect(collabFeatureOf({ saved: true })).toBe(true)
    expect(collabFeatureOf({ saved: false })).toBe(false)
    expect(collabFeatureOf({ saved: 'true' as unknown as boolean })).toBe(false)
  })

  it('环境变量优先于 app.json,开与关都认', () => {
    expect(collabFeatureOf({ env: '1', saved: false })).toBe(true)
    expect(collabFeatureOf({ env: 'TRUE', saved: false })).toBe(true)
    expect(collabFeatureOf({ env: 'on', saved: true })).toBe(true)
    expect(collabFeatureOf({ env: '0', saved: true })).toBe(false)
    expect(collabFeatureOf({ env: 'off', saved: true })).toBe(false)
  })

  it('认不出的环境变量退回 app.json / 默认,不误开', () => {
    expect(collabFeatureOf({ env: 'maybe', saved: true })).toBe(true)
    expect(collabFeatureOf({ env: 'maybe' })).toBe(false)
  })
})

describe('多人协作区总开关 · 8791 真的关得掉', () => {
  it('关着:/state 说 false,协作区路由一条都不接', async () => {
    await withServer(false, async (url) => {
      const state = await (await fetch(`${url}/state`)).json() as { collab_enabled?: boolean }
      expect(state.collab_enabled).toBe(false)
      for (const path of ['/collab/presence', '/collab/types', '/collab/goal/board', '/collab/relay', '/token/personal']) {
        const res = await fetch(`${url}${path}`)
        expect(res.status, `${path} 关着时不该接`).toBe(404)
      }
    })
  })

  it('缺席(老宿主 / 单测兼容位):行为与改动前一致,协作区照旧接得上', async () => {
    await withServer(undefined, async (url) => {
      const state = await (await fetch(`${url}/state`)).json() as { collab_enabled?: boolean }
      expect(state.collab_enabled).toBe(true)
      const presence = await fetch(`${url}/collab/presence`)
      expect(presence.status).toBe(200)
    })
  })
})
