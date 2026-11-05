// @vitest-environment node
/**
 * 「协议开的线程起了名字之后,按名字找得着它吗」(2026-10-03,卡「Codex 线程起名」)。
 *
 * 10-02 的硬伤(见 `docs/交接-1002-Codex协议适配器.md`「桌面 App 里能不能看到新线程」):
 * 协议开的线程没名字 → `~/.codex/session_index.jsonl` 里不进这一行 →
 * 她的 ChatGPT App 侧栏列不出来,`codexThreads.ts` 也找不着派出去的活。
 * 这一份钉的是**那条链的下半截**:适配器起的那个名字(`codexThreadNameOf`)
 * 与 `findCodexThread` 按名字找的那一下,**用的必须是同一个字**。
 *
 * 全部在临时目录里跑,**不碰 `~/.codex`**(维护者真在用的那一份一个字节都不读、不写)。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findCodexThread, matchThreads, parseSessionIndex } from '../src/server/codexThreads.ts'
import { codexThreadNameOf } from '../src/server/engine/adapters/codex.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 真机 `~/.codex/session_index.jsonl` 的一行:`{id, thread_name, updated_at}`(10-03 本机核过字段名)。 */
function indexRow(id: string, threadName: string | undefined, updatedAt: string): string {
  return JSON.stringify({ id, ...(threadName === undefined ? {} : { thread_name: threadName }), updated_at: updatedAt })
}

/** 摆一个假 codexHome:索引 + 这条线程的记录文件(`findCodexThread` 几条都像时按它排序)。 */
function codexHome(rows: readonly string[], options: { rollout?: string, now: number }): string {
  const home = temp('wb-codex-name-')
  writeFileSync(join(home, 'session_index.jsonl'), rows.join('\n'))
  if (options.rollout !== undefined) {
    const day = new Date(options.now)
    const dir = join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-03T07-40-00-${options.rollout}.jsonl`)
    writeFileSync(file, '{}\n')
    utimesSync(file, new Date(options.now), new Date(options.now))
  }
  return home
}

const NOW = Date.parse('2026-10-03T08:00:00Z')
/** 协议 `thread/start` 回的那种 id(10-02 真机那一条的形状)。 */
const THREAD_ID = '01a0fcc1-4e2c-7dd0-a9a6-37a6e47f0cb0'

describe('派出去的活起了名字 → 按名字找得着那条线程', () => {
  it('卡标题当名字:findCodexThread 拿同一个字找回 threadId', async () => {
    const name = codexThreadNameOf('【工作台派活 ab12cd】加个导出 PDF', '加个导出 PDF')
    expect(name).toBe('加个导出 PDF')
    const home = codexHome([
      indexRow('01a0f294-fa99-7f90-9ec6-423ef165423c', '评估项目参赛契合度', '2026-09-14T07:08:55Z'),
      indexRow(THREAD_ID, name as string, '2026-10-03T07:40:00Z'),
    ], { rollout: THREAD_ID, now: NOW })

    expect(await findCodexThread(name as string, home, () => NOW)).toEqual({ id: THREAD_ID, title: '加个导出 PDF' })
  })

  it('查不到卡那一种(交代第一行截 30 字)也找得着', async () => {
    const first = '把参赛网页的三幕叙事从首屏一路改到页脚,顺带把里头的截图也换成 10-02 那一版'
    const name = codexThreadNameOf(`${first}\n细节见卡`) as string
    expect(name).toBe(first.slice(0, 30))
    const home = codexHome([indexRow(THREAD_ID, name, '2026-10-03T07:40:00Z')], { rollout: THREAD_ID, now: NOW })

    expect(await findCodexThread(name, home, () => NOW)).toEqual({ id: THREAD_ID, title: name })
    // 她在手机 / 界面上输的是卡标题的头几个字,也该找得着(`matchThreads` 是「名字里带着」)。
    expect(await findCodexThread('三幕叙事', home, () => NOW)).toMatchObject({ id: THREAD_ID })
  })

  it('同一张卡派第二次、Codex 又开一条同名线程 → 挑记录文件新的那条', async () => {
    const older = '01a0fc96-f6ac-78c1-a3e6-76e7ba72d97f'
    const home = codexHome([
      indexRow(older, '加个导出 PDF', '2026-10-02T20:29:00Z'),
      indexRow(THREAD_ID, '加个导出 PDF', '2026-10-03T07:40:00Z'),
    ], { rollout: THREAD_ID, now: NOW })

    expect(await findCodexThread('加个导出 PDF', home, () => NOW)).toEqual({ id: THREAD_ID, title: '加个导出 PDF' })
  })

  it('★ 没起名的那条:索引里这一行认都不认 —— 10-02「App 里找不着」就是这个原因', async () => {
    const rows = [indexRow(THREAD_ID, undefined, '2026-10-02T20:49:00Z')]
    expect(parseSessionIndex(rows.join('\n'))).toEqual([])
    expect(matchThreads(parseSessionIndex(rows.join('\n')), '加个导出 PDF')).toEqual([])

    const home = codexHome(rows, { rollout: THREAD_ID, now: NOW })
    expect(await findCodexThread('加个导出 PDF', home, () => NOW)).toBeUndefined()
  })

  it('名字空白也当没起名(不许拿一行空名字冒充找得着)', () => {
    expect(parseSessionIndex(indexRow(THREAD_ID, '   ', '2026-10-03T07:40:00Z'))).toEqual([])
  })
})
