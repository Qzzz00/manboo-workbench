/**
 * 房间代理与直连同一套请求号(2026-10-12,卡「手机交代只执行一次」)。
 *
 * 去重在 8791(workbench-plugin/src/server/clientKeys.ts)按「设备 · 路径 · client_key」认;
 * 工人这一侧只要做到两件:① body 里的 `client_key` 原样带过去;② 认请求号的那几条手机在外面也走得了(在白名单里)。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { handleRpcRequest, isAllowedRpcPath } from '../src/rpc.ts'

const PLUGIN_CLIENT_KEYS = join(dirname(fileURLToPath(import.meta.url)), '../../workbench-plugin/src/server/clientKeys.ts')

/** 读 8791 那张表的源头(不抄一份)。 */
function pluginClientKeyPaths(): string[] {
  const source = readFileSync(PLUGIN_CLIENT_KEYS, 'utf8')
  const block = /export const CLIENT_KEY_PATHS[^[]*\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1]!)
}

describe('请求号经房间代理', () => {
  it('body 里的 client_key 原样转给 8791', async () => {
    const calls: unknown[] = []
    await handleRpcRequest(
      { id: 'a', type: 'http', method: 'POST', path: '/butler/item', body: { text: '买咖啡豆', client_key: 'k-1' } },
      {
        deviceId: 'dev-1',
        workbench: {
          callAsDevice: async (input: unknown) => { calls.push(input); return { status: 200, body: { ok: true } } },
          renewTicket: async () => ({ token: 't', expires_at: 1 }),
        } as Parameters<typeof handleRpcRequest>[1]['workbench'],
      },
    )
    expect(calls).toEqual([{ deviceId: 'dev-1', method: 'POST', path: '/butler/item', body: { text: '买咖啡豆', client_key: 'k-1' } }])
  })

  it('8791 认请求号的那几条,房间代理都放行(出门补发走得通)', () => {
    const paths = pluginClientKeyPaths()
    expect(paths).toContain('/butler/item')
    for (const path of paths) expect(isAllowedRpcPath('POST', path), path).toBe(true)
  })
})
