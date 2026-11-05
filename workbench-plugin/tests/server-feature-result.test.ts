// @vitest-environment node
/**
 * 派出去的子事项跑完之后,**结果自己回到卡上**(2026-09-23,断点 B)。
 *
 * 这一份钉的是**那份结果文件的形状**:
 *
 * 1. 退出码原样在最上面一行,成没成只由它说了算;
 * 2. 日志留**最后 200 行**,砍掉的行数如实说一句(不悄悄砍头);
 * 3. 「改了哪些文件」是工作台自己跑 `git status --short` / `git diff --stat` 取的,
 *    跑不起来**不是错**,如实记一句,退出码照样留着;
 * 4. 测试:项目根 package.json 有 `test` 才跑;没有就写清是哪一种"没有";
 * 5. 截图:这台机器上没有 —— **写「没截」并写清为什么**(卡里那句逐字)。
 *
 * 落盘全在 `mkdtemp` 出来的临时目录里,命令执行器是假的(一条真命令都没跑)。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunCommand } from '../src/server/featureResult.ts'
import {
  NO_SHOT_NOTE, RESULT_LOG_TAIL, buildFeatureResultDoc, collectChangedFiles, listFeatureResults,
  probeTestScript, resultFileOf, runProjectTest, tailLines, writeFeatureResult,
} from '../src/server/featureResult.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-feature-result-'))
  dirs.push(dir)
  return dir
}

/** 假执行器:按 `cmd args` 查表。没查到的一律 127(= 这台机器上没有这条命令)。 */
function fakeRun(table: Readonly<Record<string, { code: number, out: string }>>): RunCommand & { calls: string[] } {
  const calls: string[] = []
  const run = (async (input) => {
    const key = [input.cmd, ...input.args].join(' ')
    calls.push(`${key} @ ${input.cwd}`)
    return table[key] ?? { code: 127, out: `command not found: ${input.cmd}` }
  }) as RunCommand & { calls: string[] }
  run.calls = calls
  return run
}

describe('文件名', () => {
  it('结果-<子事项>.md', () => {
    expect(resultFileOf('改样式')).toBe('结果-改样式.md')
  })

  it('带 / 或点开头的名字拒绝 —— 它要当文件名用(**不拼半截路径**)', () => {
    expect(resultFileOf('a/b')).toBeUndefined()
    expect(resultFileOf('../逃')).toBeUndefined()
    expect(resultFileOf('  ')).toBeUndefined()
  })
})

describe('最后 200 行', () => {
  it('不到 200 行全留着,cut 是 0', () => {
    const { text, cut } = tailLines('a\nb\nc\n')
    expect(text).toBe('a\nb\nc')
    expect(cut).toBe(0)
  })

  it('超了只留最后 200 行,**砍掉多少如实说**', () => {
    const log = Array.from({ length: 260 }, (_, i) => `第 ${i + 1} 行`).join('\n')
    const { text, cut } = tailLines(log)
    expect(text.split('\n')).toHaveLength(RESULT_LOG_TAIL)
    expect(text.split('\n')[0]).toBe('第 61 行')
    expect(cut).toBe(60)
    expect(buildFeatureResultDoc({ item: 'x', exitCode: 0, log, at: new Date(0) }))
      .toContain('(前面还有 60 行没贴)')
  })
})

describe('改了哪些文件', () => {
  it('两条 git 都成 = 原文进文件', async () => {
    const run = fakeRun({
      'git -c core.quotepath=false status --short': { code: 0, out: ' M workbench-plugin/src/a.ts\n' },
      'git -c core.quotepath=false diff --stat': { code: 0, out: ' 1 file changed, 2 insertions(+)\n' },
    })
    const changed = await collectChangedFiles(run, '/repo')
    expect(changed).toEqual({ status: 'M workbench-plugin/src/a.ts', stat: '1 file changed, 2 insertions(+)' })
    const doc = buildFeatureResultDoc({ item: '改样式', exitCode: 0, changed, at: new Date(0) })
    expect(doc).toContain('workbench-plugin/src/a.ts')
    expect(doc).toContain('1 file changed')
  })

  it('不是 git 仓库 **不是错**:记一句,退出码照样留着', async () => {
    const changed = await collectChangedFiles(fakeRun({}), '/不是仓库')
    expect(changed.error).toContain('git status 没跑成')
    const doc = buildFeatureResultDoc({ item: '改样式', exitCode: 0, changed, at: new Date(0) })
    expect(doc).toContain('- 成没成:**成了**(退出码 0)')
    expect(doc).toContain('git status 没跑成')
  })

  it('一个文件都没改时说得清清楚楚', async () => {
    const run = fakeRun({ 'git -c core.quotepath=false status --short': { code: 0, out: '' }, 'git -c core.quotepath=false diff --stat': { code: 0, out: '' } })
    const doc = buildFeatureResultDoc({
      item: 'x', exitCode: 0, changed: await collectChangedFiles(run, '/repo'), at: new Date(0),
    })
    expect(doc).toContain('一个文件都没改')
  })
})

describe('测试跑没跑', () => {
  it('package.json 有 test 就跑一次,结果摘要进文件', async () => {
    const probe = probeTestScript(JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(probe.can).toBe(true)
    const run = fakeRun({ 'npm test --silent': { code: 0, out: 'Tests  12 passed (12)\n' } })
    const outcome = await runProjectTest(run, '/repo', probe)
    expect(outcome.ran).toBe(true)
    expect(outcome.code).toBe(0)
    expect(buildFeatureResultDoc({ item: 'x', exitCode: 0, test: outcome, at: new Date(0) }))
      .toContain('Tests  12 passed')
  })

  it('测试红时原样写「没通过」(不替它说成了)', async () => {
    const probe = probeTestScript(JSON.stringify({ scripts: { test: 'vitest run' } }))
    const run = fakeRun({ 'npm test --silent': { code: 1, out: 'Tests  1 failed\n' } })
    const outcome = await runProjectTest(run, '/repo', probe)
    expect(outcome.why).toContain('测试没通过')
  })

  it('三种"跑不了"各说各的,不含糊成一句「没跑测试」', async () => {
    expect(probeTestScript(undefined).why).toContain('没有 package.json')
    expect(probeTestScript('坏的').why).toContain('解析不了')
    expect(probeTestScript(JSON.stringify({ scripts: {} })).why).toContain('没有 test 脚本')
    const outcome = await runProjectTest(fakeRun({}), '/repo', probeTestScript(undefined))
    expect(outcome.ran).toBe(false)
    // 跑不了就**一条命令都不发**。
    expect(buildFeatureResultDoc({ item: 'x', exitCode: 0, test: outcome, at: new Date(0) }))
      .toContain('没跑:项目根没有 package.json')
  })
})

describe('截图', () => {
  it('没有截屏能力时写「没截」,而且写清为什么(卡里那句逐字)', () => {
    const doc = buildFeatureResultDoc({ item: 'x', exitCode: 0, at: new Date(0) })
    expect(doc).toContain('## 截图')
    expect(doc).toContain(NO_SHOT_NOTE)
    expect(doc).toContain('没截')
  })

  it('哪天真有了路径就写路径', () => {
    const doc = buildFeatureResultDoc({ item: 'x', exitCode: 0, shot: 'docs/需求/x/截图/1.png', at: new Date(0) })
    expect(doc).toContain('docs/需求/x/截图/1.png')
    expect(doc).not.toContain('没截')
  })
})

describe('落盘与回读', () => {
  it('一件子事项一份文件,重派一次覆盖同一份', async () => {
    const dir = tempDir()
    const first = await writeFeatureResult(dir, { item: '改样式', exitCode: 1, log: '第一次', at: new Date(0) })
    expect(first.ok).toBe(true)
    expect(first.file).toBe('结果-改样式.md')
    await writeFeatureResult(dir, { item: '改样式', exitCode: 0, log: '第二次', at: new Date(0) })
    const text = readFileSync(join(dir, '结果-改样式.md'), 'utf8')
    expect(text).toContain('第二次')
    expect(text).not.toContain('第一次')
    expect(text).toContain('- 成没成:**成了**(退出码 0)')
  })

  it('名字当不了文件名时**拒绝**,不写一个半截路径出来', async () => {
    const dir = tempDir()
    const result = await writeFeatureResult(dir, { item: '../逃', exitCode: 0, at: new Date(0) })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不能带')
  })

  it('「验收」页签念的那一份:现扫目录,一行摘要说清成没成', async () => {
    const dir = tempDir()
    await writeFeatureResult(dir, { item: '改样式', exitCode: 0, at: new Date(0) })
    await writeFeatureResult(dir, { item: '跑测试', exitCode: 2, at: new Date(0) })
    const listed = await listFeatureResults(dir)
    expect(listed.map(one => one.item)).toEqual(['改样式', '跑测试'])
    expect(listed[0]?.ok).toBe(true)
    expect(listed[1]?.ok).toBe(false)
    expect(listed[1]?.summary).toContain('没成')
    expect(listed[1]?.summary).toContain('退出码 2')
  })

  it('目录还没有 = 空数组(**不是错**:这条需求还没派过活)', async () => {
    expect(await listFeatureResults(join(tempDir(), '还没有这个目录'))).toEqual([])
  })
})
