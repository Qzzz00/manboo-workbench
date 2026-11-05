/**
 * 模型从哪儿来(`~/.dsh/workbench/model.json` 的 mode)。
 *
 * 只读一个字段,而且**认不出的值不猜** —— 猜错的那一半会让额度面板上的钱数指向错的账户。
 */
import { describe, expect, it } from 'vitest'
import { createModelModeReader, defaultModelFile, parseModelMode } from '../src/server/modelMode.ts'

describe('parseModelMode', () => {
  it('relay / own 认得', () => {
    expect(parseModelMode('{"mode":"relay"}')).toBe('relay')
    expect(parseModelMode('{"mode":"own"}')).toBe('own')
  })

  it('★文件不存在 / 写坏了 / 值认不出 → 一律 undefined,不替它选一个', () => {
    expect(parseModelMode(undefined)).toBeUndefined()
    expect(parseModelMode('{ 这不是 json')).toBeUndefined()
    expect(parseModelMode('{"mode":"auto"}')).toBeUndefined()
    expect(parseModelMode('{}')).toBeUndefined()
    expect(parseModelMode('null')).toBeUndefined()
    expect(parseModelMode('"relay"')).toBeUndefined()
  })

  it('文件落在 ~/.dsh/workbench/model.json(跟 credentials.json / apps.json 同一个目录)', () => {
    expect(defaultModelFile('/Users/example')).toBe('/Users/example/.dsh/workbench/model.json')
  })
})

describe('接没接中转(/state.relay_configured,2026-10-21)', () => {
  it('没读过时按构建缺省说(用例跑的是开源缺省 = 没接);读到 model.json 里的地址就是接了', async () => {
    let text: string | undefined
    const reader = createModelModeReader({ readFile: async () => text, file: '/x/model.json', now: () => 0, refreshMs: 0 })
    expect(reader.relayConfigured?.()).toBe(false)
    await reader.read()
    expect(reader.relayConfigured?.()).toBe(false)
    text = '{"mode":"relay","relay_url":"https://self.example"}'
    await reader.read()
    expect(reader.relayConfigured?.()).toBe(true)
  })
})

describe('createModelModeReader', () => {
  it('读一次之后 view() 拿得到;60 秒内 pump() 不重读', async () => {
    let reads = 0
    let text: string | undefined = '{"mode":"relay"}'
    let clock = 1_000_000
    const reader = createModelModeReader({
      readFile: async () => { reads += 1; return text },
      file: '/x/model.json',
      now: () => clock,
    })
    expect(reader.view()).toBeUndefined() // 还没读过
    await reader.read()
    expect(reader.view()).toBe('relay')
    expect(reads).toBe(1)

    text = '{"mode":"own"}'
    for (let i = 0; i < 20; i++) reader.pump()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reader.view()).toBe('relay')
    expect(reads).toBe(1)

    clock += 60_001
    reader.pump()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reader.view()).toBe('own')
    expect(reads).toBe(2)
  })
})
