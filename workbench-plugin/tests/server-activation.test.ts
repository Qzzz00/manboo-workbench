import { describe, expect, it } from 'vitest'
import { FAMILY_SOURCES } from '../src/server/agentSources.ts'
import { APP_BUNDLES, ensureRunning, isRunning } from '../src/server/activation.ts'

const noSleep = (): Promise<void> => Promise.resolve()

describe('activation(激活+lsappinfo 校验+重试,调研 §R1R2)', () => {
  /**
   * ★ 2026-09-27(卡 HC「不写死各家 AI」):AI 那几家的包标识不再在这里数第二遍 ——
   * 它们从那张知识表(`FAMILY_SOURCES`)现长,新写一家专门读法这一条就该自己跟上。
   * 这里钉的是**换算不能少**:知识表里每一条带包标识的都要在 APP_BUNDLES 里换算得到
   * (原来只有 claude / codex / kimi,于是全新 Air 上装着的豆包办公在坞与窗位清单里
   * 一处都换算不出来),外加不是 AI 的那四个照旧逐字钉住。
   */
  it('APP_BUNDLES:知识表里每一家 AI 都换算得到,另外四个非 AI 的逐字不变', () => {
    for (const one of FAMILY_SOURCES) {
      if (one.bundle_id === undefined) continue
      expect(APP_BUNDLES[one.agent]).toBe(one.bundle_id)
    }
    // 豆包办公那一条是这张卡的现场(维护者:「豆包办公还认不出来呢」)。
    expect(APP_BUNDLES.doubao).toBe('com.bot.pc.doubao')
    expect(APP_BUNDLES.wechat).toBe('com.tencent.xinWeChat')
    expect(APP_BUNDLES.wecom).toBe('com.tencent.WeWorkMac')
    expect(APP_BUNDLES.term).toBe('com.apple.Terminal')
    expect(APP_BUNDLES.calendar).toBe('com.apple.iCal')
  })

  it('isRunning:lsappinfo 输出带 "pid"=N 判运行中;空输出判未运行(§R4:空输出≠0)', async () => {
    expect(await isRunning('x', async () => ({ ok: true, stdout: '"pid"=63274\n' }))).toBe(true)
    expect(await isRunning('x', async () => ({ ok: true, stdout: '' }))).toBe(false)
    expect(await isRunning('x', async () => ({ ok: false, stdout: '' }))).toBe(false)
  })

  it('已在运行:不发 open 命令直接 ok', async () => {
    const calls: string[][] = []
    const run = async (cmd: readonly string[]) => {
      calls.push([...cmd])
      return { ok: true, stdout: cmd[0] === 'lsappinfo' ? '"pid"=1\n' : '' }
    }
    expect(await ensureRunning('term', { runCommand: run, sleep: noSleep })).toEqual({ ok: true })
    expect(calls.some(c => c[0] === 'open')).toBe(false)
  })

  it('第一轮激活后校验不过→重试→第二轮过(flaky 50% 的闭环,调研 §R1 双开)', async () => {
    let lsCount = 0
    const calls: string[][] = []
    const run = async (cmd: readonly string[]) => {
      calls.push([...cmd])
      if (cmd[0] === 'lsappinfo') {
        lsCount += 1
        // 前 2 次校验(初查+第一轮激活后)都说没起来,第 3 次才有 pid。
        return { ok: true, stdout: lsCount >= 3 ? '"pid"=9\n' : '' }
      }
      return { ok: true, stdout: '' }
    }
    expect(await ensureRunning('wechat', { runCommand: run, sleep: noSleep })).toEqual({ ok: true })
    expect(calls.filter(c => c[0] === 'open').length).toBeGreaterThanOrEqual(1)
    expect(calls.filter(c => c[0] === 'open').every(c => c[1] === '-b' && c[2] === 'com.tencent.xinWeChat')).toBe(true)
  })

  it('重试次数用尽仍未运行→ok:false 且 reason 带 bundle id(如实失败,不装成功)', async () => {
    const run = async (cmd: readonly string[]) => ({ ok: true, stdout: cmd[0] === 'lsappinfo' ? '' : '' })
    const result = await ensureRunning('kimi', { runCommand: run, sleep: noSleep, attempts: 2 })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('com.moonshot.kimichat')
  })

  it('不认识的 app(含 __proto__ 原型键)→ok:false,不发任何命令', async () => {
    const calls: string[][] = []
    const run = async (cmd: readonly string[]) => { calls.push([...cmd]); return { ok: true, stdout: '' } }
    expect((await ensureRunning('__proto__', { runCommand: run, sleep: noSleep })).ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})
