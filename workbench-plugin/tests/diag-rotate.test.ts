// @vitest-environment node
/**
 * 日志轮转与总量封顶(2026-09-22)。
 *
 * 最要紧的一条在最后一个 describe:**轮转用的是原地截断,不是 rename**。
 * launchd 与工人拿着这些文件的 fd;rename 之后它们会继续往那个已经改名的 inode 里写,
 * 于是"轮转"变成"从此再也没有新日志"。这里用一个真的、开着 append fd 的文件验它。
 */
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { nodeSetupIo } from '../src/server/setup/io.ts'
import { setupPaths, type SetupPaths } from '../src/server/setup/paths.ts'
import { nodeDiagIo } from '../src/server/diagnostics/io.ts'
import { dayKeyOf, listLogFiles, parseRotateState, rotateDiagLogs, rotateStateFile } from '../src/server/diagnostics/rotate.ts'

const TZ = 8 * 60
const DAY1 = Date.parse('2026-09-21T02:00:00.000Z') // 东八区 9-21 10:00
const DAY2 = Date.parse('2026-09-22T02:00:00.000Z') // 东八区 9-22 10:00

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function machine(): { paths: SetupPaths, io: ReturnType<typeof nodeDiagIo>, web: string } {
  const home = mkdtempSync(join(tmpdir(), 'wb-rot-home-'))
  dirs.push(home)
  const paths = setupPaths({ home, applicationsDir: join(home, 'Applications') })
  mkdirSync(paths.logsDir, { recursive: true })
  mkdirSync(`${paths.dshHome}/workbench/logs`, { recursive: true })
  return { paths, io: nodeDiagIo(nodeSetupIo()), web: `${paths.logsDir}/web.stdout.log` }
}

function run(m: ReturnType<typeof machine>, now: number, patch: Record<string, unknown> = {}) {
  return rotateDiagLogs({ io: m.io, paths: m.paths, now: () => now, tzOffsetMinutes: TZ, ...patch })
}

describe('按天', () => {
  it('第一次见到一份日志只记一天,不转 —— 不然装完当天就先空转一次', async () => {
    const m = machine()
    writeFileSync(m.web, '第一天的内容\n')
    const out = await run(m, DAY1)
    expect(out.rotated.length).toBe(0)
    const state = parseRotateState(readFileSync(rotateStateFile(m.paths), 'utf8'))
    expect(state.last['web.stdout.log']).toBe('2026-09-21')
  })

  it('第二天再来就转:内容进 `<名字>.<上一天>`,活着那份清空', async () => {
    const m = machine()
    writeFileSync(m.web, '第一天的内容\n')
    await run(m, DAY1)
    appendFileSync(m.web, '还是第一天\n')
    const out = await run(m, DAY2)
    expect(out.rotated.length).toBe(1)
    expect(out.rotated[0]?.to).toBe(`${m.web}.2026-09-21`)
    expect(readFileSync(`${m.web}.2026-09-21`, 'utf8')).toContain('第一天的内容')
    expect(statSync(m.web).size).toBe(0)
  })

  it('**幂等**:同一天里再调一次什么都不动', async () => {
    const m = machine()
    writeFileSync(m.web, 'x\n')
    await run(m, DAY1)
    await run(m, DAY2)
    writeFileSync(m.web, '新的一行\n')
    const again = await run(m, DAY2 + 60_000)
    expect(again.rotated.length).toBe(0)
    expect(readFileSync(m.web, 'utf8')).toBe('新的一行\n')
  })

  it('空文件不转', async () => {
    const m = machine()
    writeFileSync(m.web, '')
    await run(m, DAY1)
    expect((await run(m, DAY2)).rotated.length).toBe(0)
  })

  it('「今天」按本地时区算,不按 UTC', () => {
    // 2026-09-21T18:00Z 在东八区已经是 9-22 凌晨 2 点
    expect(dayKeyOf(Date.parse('2026-09-21T18:00:00Z'), TZ)).toBe('2026-09-22')
    expect(dayKeyOf(Date.parse('2026-09-21T18:00:00Z'), 0)).toBe('2026-09-21')
  })
})

describe('按大小', () => {
  it('还没到第二天,但单份超了上限也转', async () => {
    const m = machine()
    writeFileSync(m.web, 'x\n')
    await run(m, DAY1)
    writeFileSync(m.web, 'y'.repeat(5000))
    const out = await run(m, DAY1 + 60_000, { rotateAtBytes: 1000 })
    expect(out.rotated.length).toBe(1)
    expect(statSync(m.web).size).toBe(0)
  })

  it('抄的是尾巴,**丢了多少如实回报**', async () => {
    const m = machine()
    writeFileSync(m.web, 'x\n')
    await run(m, DAY1)
    writeFileSync(m.web, `${'老的'.repeat(3000)}最后一行`)
    const out = await run(m, DAY1 + 60_000, { rotateAtBytes: 1000, keepBytes: 200 })
    expect(out.rotated[0]?.dropped_bytes).toBeGreaterThan(0)
    expect(readFileSync(`${m.web}.2026-09-21`, 'utf8')).toContain('最后一行')
  })
})

describe('总量封顶', () => {
  it('超过总量就从最老的轮转文件开始删,活着那几份不删', async () => {
    const m = machine()
    writeFileSync(m.web, '活着的那一份\n')
    for (const [i, day] of ['2026-09-10', '2026-09-11', '2026-09-12'].entries()) {
      writeFileSync(`${m.web}.${day}`, 'z'.repeat(1000 * (i + 1)))
    }
    const out = await run(m, DAY2, { maxTotalBytes: 2500 })
    expect(out.removed.length).toBeGreaterThan(0)
    expect(out.removed.every(item => item.file.includes('.2026-09-1'))).toBe(true)
    // 活着那一份还在
    expect(readFileSync(m.web, 'utf8')).toBe('活着的那一份\n')
  })

  it('过了保留天数的一律删,哪怕总量没超', async () => {
    const m = machine()
    writeFileSync(m.web, '活着\n')
    writeFileSync(`${m.web}.2026-08-01`, '很久以前')
    // 保留期按**文件的修改时间**算(轮转出来那一刻写的,之后再没动过),
    // 不按名字里那个日期 —— 名字可以被人手改,mtime 不会。所以这里要真的把它拨老。
    const old = Date.parse('2026-08-01T10:00:00Z') / 1000
    utimesSync(`${m.web}.2026-08-01`, old, old)
    const out = await run(m, DAY2, { keepDays: 3, maxTotalBytes: 1024 * 1024 })
    expect(out.removed.some(item => item.why.includes('超过 3 天'))).toBe(true)
    expect(readdirSync(m.paths.logsDir)).not.toContain('web.stdout.log.2026-08-01')
  })
})

describe('listLogFiles', () => {
  it('活着的与轮转出来的都列得出来,并分得清哪是哪', async () => {
    const m = machine()
    writeFileSync(m.web, 'a')
    writeFileSync(`${m.web}.2026-09-20`, 'b')
    writeFileSync(`${m.paths.dshHome}/workbench/logs/channel-worker.log`, 'c')
    const all = await listLogFiles(m.io, m.paths)
    const byPath = Object.fromEntries(all.map(item => [item.path, item.rotated]))
    expect(byPath[m.web]).toBe(false)
    expect(byPath[`${m.web}.2026-09-20`]).toBe(true)
    expect(all.length).toBe(3)
  })
})

describe('原地截断,不是 rename', () => {
  it('别的进程拿着 append fd 在写,轮转之后它写的字**还在活着那一份里**', async () => {
    const m = machine()
    writeFileSync(m.web, '开头\n')
    await run(m, DAY1)
    // 扮演 launchd:拿一个 O_APPEND 的 fd 一直开着
    const fd = openSync(m.web, 'a')
    try {
      writeSync(fd, '轮转前写的\n')
      await run(m, DAY2)
      writeSync(fd, '轮转后写的\n')
      const live = readFileSync(m.web, 'utf8')
      // 这一条就是那个会真出事的地方:rename 的话这一行会跑进 .2026-09-21 里,
      // 而活着那份永远是空的。
      expect(live).toContain('轮转后写的')
      expect(readFileSync(`${m.web}.2026-09-21`, 'utf8')).toContain('轮转前写的')
    }
    finally { closeSync(fd) }
  })
})
