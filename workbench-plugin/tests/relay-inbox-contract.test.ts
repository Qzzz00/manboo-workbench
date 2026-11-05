// @vitest-environment node
/**
 * 中转接口这条接缝的对照(2026-10-21,协作区中转底座):`protocol.ts` 里的几张清单
 * 与中转源头 `relay/server/collab.cjs` 读出来的一致。两边工具链独立、互不 import,所以读源文件比对。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CHANNEL_MESSAGE_KINDS, COLLAB_OBJECT_KINDS, INBOX_EVENT_KINDS, INBOX_REQUEST_OPS, WORKSPACE_ROLES } from '../src/protocol.ts'

const source = readFileSync(new URL('../../relay/server/collab.cjs', import.meta.url), 'utf8')

function setOf(name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)
  if (m === null) throw new Error(`collab.cjs 里没找到 ${name}`)
  return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1] as string)
}

describe('protocol.ts ↔ relay/server/collab.cjs', () => {
  it('请求的种类:客户端能发的 + 中转自己投的', () => {
    expect([...INBOX_REQUEST_OPS].sort()).toEqual([...setOf('REQUEST_OPS'), ...setOf('SERVER_OPS')].sort())
  })

  it('消息种类、角色、对象种类(频道由中转建,不在可登记清单里)', () => {
    expect([...CHANNEL_MESSAGE_KINDS].sort()).toEqual(setOf('MESSAGE_KINDS').sort())
    expect([...WORKSPACE_ROLES].sort()).toEqual(setOf('ROLES').sort())
    expect([...COLLAB_OBJECT_KINDS].filter(k => k !== 'channel').sort()).toEqual(setOf('OBJECT_KINDS').sort())
  })

  it('中转会放进事件队列的种类,协议里都有', () => {
    const emitted = new Set([...source.matchAll(/kind: '([a-z]+\.[a-z]+)'/g)].map(x => x[1]))
    expect([...emitted].sort()).toEqual([...INBOX_EVENT_KINDS].sort())
  })
})
