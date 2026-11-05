// @vitest-environment node
/**
 * 8791 热点第三轮(2026-10-28,任务书 docs/交接-1028-8791热点第三轮-Kimi定位stat风暴.md):
 * locateKimiCliSession 的 stat 风暴与每拍重扫。这一文件固定「按拍缓存」的验收语义:
 *   1. 同一拍两次定位同一会话,第二次零 stat(会话目录每拍至多复核一次);
 *   2. 目录 mtime 不变,第二拍零 readdir;
 *   3. 不存在的路径,第二拍零 stat(不再反复探不存在的东西);
 *   4. 文件被删后下一拍重扫,换路径后找到新路径;
 *   5. 校验失败(工作树没了)不每拍重扫,恢复后免扫找回 —— 16:47 风暴场景的回归闸。
 * 契约不变:每次定位仍走 locateKimiCliSession 全量校验(逐拍核源、项目门现查),缓存只省文件系统遍历。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKimiExecutionLocator } from '../src/server/cliSessionRead.ts'

const fsCounts = vi.hoisted(() => ({ readdir: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real,
    readdir: ((path: unknown, options?: unknown) => {
      fsCounts.readdir++
      return (real.readdir as (p: unknown, o?: unknown) => unknown)(path, options)
    }) as typeof real.readdir,
  }
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(groups: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-beat-'))); dirs.push(home)
  const root = join(home, '.kimi-code', 'sessions')
  const cwd = join(home, 'project'); mkdirSync(cwd)
  for (let n = 0; n < groups; n++) mkdirSync(join(root, `g-${n}`), { recursive: true })
  const sessionId = 'session-beat-cache'
  const dir = join(root, 'g-03', sessionId)
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd }))
  const file = join(dir, 'agents', 'main', 'wire.jsonl'); writeFileSync(file, '{}\n')
  return { home, root, cwd, sessionId, dir, file }
}

/**
 * 统计注入定位器的 statFile。拍签名只碰根与组(深度 ≤1),不计入;
 * 会话条目(深度 ≥2:会话目录、wire 路径)才算探测 —— 风暴就是这种探测的反复失败。
 */
function counter(root: string) {
  const counts = { sessionEntries: 0, failed: 0 }
  const statFile = (async (path: string, options?: { bigint?: boolean }) => {
    const rel = relative(root, path)
    if (rel !== '' && !rel.startsWith('..') && rel.includes(sep)) counts.sessionEntries++
    try { return await stat(path, options as never) }
    catch (error) { counts.failed++; throw error }
  }) as typeof stat
  return { counts, statFile }
}

describe('Kimi 执行定位按拍缓存(8791 热点第三轮)', () => {
  it('同一拍两次定位同一会话,第二次零 stat', async () => {
    const f = fixture(24)
    const c = counter(f.root)
    const locator = createKimiExecutionLocator(f.home, c.statFile)
    const locate = await locator.prepare()
    expect(await locate({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    expect(c.counts.sessionEntries).toBeGreaterThan(0) // 冷拍确曾全量探测过
    const probesAfterFirst = c.counts.sessionEntries
    expect(await locate({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    expect(c.counts.sessionEntries).toBe(probesAfterFirst) // 同一拍第二次定位零新增探测
  })

  it('目录 mtime 不变,第二拍零 readdir', async () => {
    const f = fixture(24)
    const c = counter(f.root)
    const locator = createKimiExecutionLocator(f.home, c.statFile)
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    fsCounts.readdir = 0
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    expect(fsCounts.readdir).toBe(0)
  })

  it('不存在的路径:冷拍全扫,第二拍零 stat、零失败重试', async () => {
    const f = fixture(24)
    const c = counter(f.root)
    const locator = createKimiExecutionLocator(f.home, c.statFile)
    const ghost = 'session-ghost-missing'
    expect(await (await locator.prepare())({ sessionId: ghost, cwds: [f.cwd] })).toBeUndefined()
    expect(c.counts.sessionEntries).toBeGreaterThan(0)
    const failedAfterCold = c.counts.failed
    c.counts.sessionEntries = 0
    expect(await (await locator.prepare())({ sessionId: ghost, cwds: [f.cwd] })).toBeUndefined()
    expect(c.counts.sessionEntries).toBe(0) // 第二拍不再探任何会话条目
    expect(c.counts.failed).toBe(failedAfterCold) // 也没有反复 stat 不存在的东西
  })

  it('文件被删后下一拍重扫;会话挪到别的组后找到新路径', async () => {
    const f = fixture(24)
    const c = counter(f.root)
    const locator = createKimiExecutionLocator(f.home, c.statFile)
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    rmSync(f.file)
    c.counts.sessionEntries = 0
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toBeUndefined()
    expect(c.counts.sessionEntries).toBeGreaterThan(0) // 原件失联必须真重扫,不许吃缓存
    const moved = join(f.root, 'g-11', f.sessionId)
    mkdirSync(join(moved, 'agents', 'main'), { recursive: true })
    writeFileSync(join(moved, 'state.json'), JSON.stringify({ cwd: f.cwd }))
    const newFile = join(moved, 'agents', 'main', 'wire.jsonl'); writeFileSync(newFile, '{}\n')
    rmSync(f.dir, { recursive: true, force: true })
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: newFile })
  })

  it('校验失败(工作树没了)不每拍重扫;补上目录后免扫找回', async () => {
    const f = fixture(24)
    const c = counter(f.root)
    const locator = createKimiExecutionLocator(f.home, c.statFile)
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    rmSync(f.cwd, { recursive: true, force: true }) // 16:47 现场:卡的工作树被清掉,校验落空
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toBeUndefined()
    const probesAfterMiss = c.counts.sessionEntries
    // 冷扫一遍要探全部 24 组×两个名字;稳拍至多复核一下会话目录(≤1)。
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toBeUndefined()
    const steadyPerBeat = c.counts.sessionEntries - probesAfterMiss
    expect(steadyPerBeat).toBeGreaterThanOrEqual(0)
    expect(steadyPerBeat).toBeLessThanOrEqual(1)
    mkdirSync(f.cwd) // 17:10 缓解:补回空目录
    expect(await (await locator.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
    expect(c.counts.sessionEntries - probesAfterMiss).toBeLessThanOrEqual(steadyPerBeat + 1) // 恢复也免重扫
  })
})
