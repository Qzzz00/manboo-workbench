// @vitest-environment node
/**
 * ★ **捎话巡检按家分开读**(2026-10-21,卡「派活按家隔离」的兄弟路)。
 *
 * 捎话巡检与派活巡检病在同一处:一拍里逐条 `await` 读窗,一家读不动,别家捎回来的话没人收、没人回电。
 * 现在同一家逐条、不同家并行;一家这一拍没读完,下一拍跳过它,别家照收。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayWatchService } from '../src/server/relayWatch.ts'
import type { RelayReader } from '../src/server/relayWatch.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

describe('捎话巡检按家分开读', () => {
  it('★豆包那一下读窗挂死:Kimi 捎回来的话照收、照回电;下一拍不再往豆包那条队里堆', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-relay-lanes-'))
    dirs.push(dir)
    let doubaoReads = 0
    const reader: RelayReader = {
      read: async (input) => {
        if (input.agent === 'doubao') {
          doubaoReads += 1
          return await new Promise(() => {})
        }
        return { found: true, text: 'Kimi 回了这句', busy: false }
      },
    }
    const rings: unknown[] = []
    let now = Date.parse('2026-10-21T08:00:00Z')
    let seq = 0
    const service = createRelayWatchService({
      file: join(dir, 'relay.json'),
      reader,
      callOut: { request: async (call) => { rings.push(call); return { ok: true, entry: { id: `c-${rings.length}` } } } },
      agentName: agent => agent,
      now: () => now,
      newId: () => `r-${seq += 1}`,
      pollMs: 0,
    })
    await service.load()
    await service.remember({ agent: 'doubao', session_id: 's-d', title: '豆包那条', mark: '事务官捎话 aaaaaa', from: 'phone' })
    await service.remember({ agent: 'kimi', session_id: 's-k', title: 'Kimi 那条', mark: '事务官捎话 bbbbbb', from: 'phone' })

    now += 10_000
    await service.pump()
    now += 10_000
    await service.pump()
    expect(service.list().find(one => one.agent === 'kimi')?.state).toBe('replied')
    expect(service.list().find(one => one.agent === 'doubao')?.state).toBe('waiting')
    expect(doubaoReads).toBe(1)
    expect(rings).toHaveLength(1)
  }, 15_000)
})
