// @vitest-environment node
/**
 * ★ **巡登记表:哪条会话醒过来了,就把排着的那几件重送**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
 *
 * 挂在 http 那根既有的 1 秒节拍上,内部 {@link SESSION_AWAKE_POLL_MS} 限频(建议 5 秒)。
 * 与 `screenLockWatch` 不同,这一拍没有「变过来那一下」的判断 —— 每次到点就跑一轮,
 * 空的 / 没有醒着的会话时那一轮自己什么都不做(`drainLockQueue` 空队直接返回)。
 *
 * 守:① 起服务第一拍就跑(盘上可能有上一回留下的队);② 没到点的那几拍不跑;③ 上一轮没跑完这一拍不重入。
 */
import { describe, expect, it } from 'vitest'
import { SESSION_AWAKE_POLL_MS, createSessionAwakeWatch } from '../src/server/sessionAwakeWatch.ts'

function harness() {
  const clock = { value: 1_000_000 }
  const drains: number[] = []
  const lines: string[] = []
  let busy = false
  let calls = 0
  const watch = createSessionAwakeWatch({
    drain: async () => {
      drains.push(clock.value)
      calls += 1
      if (busy) {
        // 让这一轮卡住(测重入):第一回进去把 busy 置真,第二回如果重入会再进 drain。
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      return { sent: 0, kept: 0, failed: 0 }
    },
    now: () => clock.value,
    warn: line => lines.push(line),
  })
  return { watch, clock, drains, lines, busy: (v: boolean) => { busy = v } }
}

describe('限频:挂在 1 秒节拍上,内部 5 秒一拍', () => {
  it('★第一拍就跑一轮(起服务那一下,盘上那本队可能是上一回留下的)', async () => {
    const h = harness()
    await h.watch.pump()
    expect(h.drains).toHaveLength(1)
  })

  it('★★没到点的那几拍不跑', async () => {
    const h = harness()
    await h.watch.pump()
    h.clock.value += SESSION_AWAKE_POLL_MS - 1
    await h.watch.pump()
    expect(h.drains).toHaveLength(1)
    h.clock.value += 2
    await h.watch.pump()
    expect(h.drains).toHaveLength(2)
  })

  it('★上一轮没跑完,这一拍不重入(不然两条 drain 会同时送同一条)', async () => {
    const h = harness()
    h.busy(true)
    const first = h.watch.pump()
    const second = h.watch.pump()
    await first
    await second
    expect(h.drains).toHaveLength(1)
  })

  it('★那一轮抛了:记一行,下一拍照旧跑(不把节拍带走)', async () => {
    const clock = { value: 1_000_000 }
    const lines: string[] = []
    let boom = true
    const watch = createSessionAwakeWatch({
      drain: async () => {
        if (boom) { boom = false; throw new Error('重送炸了') }
        return { sent: 0, kept: 0, failed: 0 }
      },
      now: () => clock.value,
      warn: line => lines.push(line),
    })
    await watch.pump()
    expect(lines.some(one => one.includes('重送那一轮出错'))).toBe(true)
    clock.value += SESSION_AWAKE_POLL_MS
    await watch.pump()
    expect(lines).toHaveLength(1)
  })
})
