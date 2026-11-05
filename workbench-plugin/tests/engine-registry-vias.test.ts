/**
 * ★ **一件事只许走哪几条通道**(`Job.vias`;2026-10-20 卡 D)。
 *
 * 为什么要它:终端 / VS Code 里开的 Claude 会话、终端里开的 Codex 会话,**只有协议那只手够得着**
 * (socket / `thread/resume`)。窗口那只手开的是桌面 App —— 卡 AW「认不出那段对话也照发」之后,
 * 让它接手就是把她的话打进桌面 App 里此刻开着的别的对话。从前这一道靠 `answerPlanOf` 按 entry
 * 先拒(连协议那只手也一起拒了);现在拒的只有窗口那只手,判据在登记处一处(`picksFor`),
 * 引擎的送 / 读 / 去回答 / 读弹框四个入口都经过它。
 *
 * 界面那几格读的同步那一份(`knownCaps`)也得按同一张白名单算,否则摆出一个点下去才说不行的框(D13)。
 */
import { describe, expect, it } from 'vitest'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import { createRegistry } from '../src/server/engine/registry.ts'

const NONE: AdapterCapabilities = { open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false }

function adapter(via: JobResult['via'], caps: Partial<AdapterCapabilities>): Adapter {
  return {
    family: 'claude',
    via,
    capabilities: () => Promise.resolve({ ...NONE, ...caps }),
    run: () => Promise.resolve({ delivered: 'confirmed', via } satisfies JobResult),
  }
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j', family: 'claude', kind: 'relay', target: { kind: 'session', sessionId: 's' }, text: '到哪了', expect: 'ack', ...over,
})

describe('Job.vias:只许走这几条', () => {
  it('缺席 = 不限(行为与从前一字不差)', async () => {
    const registry = createRegistry()
    registry.register(adapter('protocol', { send: true }))
    registry.register(adapter('window', { send: true, press: true }))
    expect((await registry.picksFor(job())).map(one => one.adapter.via)).toEqual(['protocol', 'window'])
  })

  it('★只许协议:窗口那条不进队;协议那条不会这一样时队是空的(引擎据此回 unsupported)', async () => {
    const registry = createRegistry()
    registry.register(adapter('protocol', { send: true }))
    registry.register(adapter('window', { send: true, press: true }))
    expect((await registry.picksFor(job({ vias: ['protocol'] }))).map(one => one.adapter.via)).toEqual(['protocol'])
    expect(await registry.picksFor(job({ kind: 'press', vias: ['protocol'] }))).toEqual([])
    // 只读一眼 / 去回答走的是同一处
    expect(await registry.picksFor(job({ vias: ['protocol'] }), { need: 'press' })).toEqual([])
  })

  it('★界面那一份(knownCaps)按同一张白名单合:窗口会的那几样不算到协议头上', async () => {
    const registry = createRegistry()
    registry.register(adapter('protocol', { send: true, read: true }))
    registry.register(adapter('window', { send: true, press: true, stop: true, writeAsk: true, approve: true }))
    await registry.targets()
    expect(registry.knownCaps('claude')).toMatchObject({ send: true, press: true, stop: true })
    expect(registry.knownCaps('claude', { vias: ['protocol'] })).toMatchObject({ send: true, read: true, press: false, stop: false, writeAsk: false, approve: false })
  })

  it('白名单里一条登记了的都没有 → undefined(「查不到」,不冒充「不行」也不冒充「行」)', async () => {
    const registry = createRegistry()
    registry.register(adapter('window', { send: true }))
    await registry.targets()
    expect(registry.knownCaps('claude', { vias: ['protocol'] })).toBeUndefined()
  })
})
