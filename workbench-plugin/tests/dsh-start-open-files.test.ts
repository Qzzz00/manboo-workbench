import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 2026-09-28 14:45 维护者本机真机:后台崩溃「EMFILE: too many open files, watch」。
// launchd 给的打开文件软上限只有 256(`launchctl limit maxfiles`),而后台要盯着各家 AI 的会话记录,
// 一涨破 256 就整个挂掉;新 Air 同样是 256。启动脚本在起 DSH 之前把软上限调高。
const script = readFileSync(resolve(process.cwd(), 'bin/dsh-start'), 'utf8')

describe('dsh-start 调高打开文件上限', () => {
  it('在 exec 起 DSH 之前调 ulimit -n,而且调不上也不挡启动', () => {
    const at = script.indexOf('ulimit -n')
    expect(at).toBeGreaterThan(0)
    expect(script.indexOf('exec ', at)).toBeGreaterThan(at)
    expect(script.slice(at, script.indexOf('\n', at))).toMatch(/\|\| true/)
  })
  it('那一行在 bash 里真能把软上限抬到 256 以上', () => {
    const line = script.split('\n').find(l => l.trimStart().startsWith('ulimit -n')) as string
    const out = execFileSync('bash', ['-c', `ulimit -S -n 256; ${line}; ulimit -S -n`], { encoding: 'utf8' }).trim()
    expect(Number(out)).toBeGreaterThan(256)
  })
})
