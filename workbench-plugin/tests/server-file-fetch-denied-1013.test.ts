// @vitest-environment node
/**
 * 手机取文件取不到、而原因是**电脑上没给文件访问授权**时,那一句要如实说
 * (2026-10-13,卡「手机看文件时电脑弹 node 的文件夹授权」)。
 *
 * 在这之前两句都把人往错的方向带:
 *   - 搜不动那个根 → 原样抛出 `…读不到(EPERM: operation not permitted, scandir …)`,
 *     她在手机上看到一串英文,不知道要去电脑上点什么;
 *   - 取件那一刻 lstat EPERM → `电脑上这个文件已经不在了(被挪走或删了)` —— **那是假话**,
 *     文件好好地在那儿,是这条 node 没权限读它。
 *
 * 现在两处都换成同一句(`FILE_ACCESS_DENIED_NOTE`),说清去哪儿点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FILE_ACCESS_DENIED_NOTE,
  buildFileAsk,
  checkOfferFile,
  createFileOffers,
  searchLocalFiles,
} from '../src/server/fileFetch.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fetch-denied-'))
  dirs.push(dir)
  return dir
}

/** 一个真的会回 EPERM 的 readdir(真实世界里是 TCC 拒的那一下)。 */
function deniedReaddir(): () => never {
  return () => {
    const error = new Error('EPERM: operation not permitted, scandir') as Error & { code: string }
    error.code = 'EPERM'
    throw error
  }
}

describe('搜的时候就读不动', () => {
  it('★根目录 EPERM:记一条「没给授权」,而不是把 EPERM 原文摆给她', async () => {
    const outcome = await searchLocalFiles(
      { roots: [{ path: '/Users/x/Documents', label: '文稿' }], terms: ['readme'] },
      { readdirImpl: deniedReaddir() },
    )
    expect(outcome.denied).toEqual(['/Users/x/Documents'])
    expect(outcome.errors).toEqual([])
  })

  it('别的原因(目录不存在)照旧原样说 —— 那不是授权问题', async () => {
    const outcome = await searchLocalFiles(
      { roots: [{ path: '/Users/x/没有这个目录', label: '文稿' }], terms: ['readme'] },
      {
        readdirImpl: () => {
          const error = new Error('ENOENT: no such file or directory') as Error & { code: string }
          error.code = 'ENOENT'
          throw error
        },
      },
    )
    expect(outcome.denied).toEqual([])
    expect(outcome.errors.length).toBe(1)
    expect(outcome.errors[0]).toContain('文稿')
  })

  it('★手机那张卡上那一句:「电脑上还没给文件访问授权」+ 去哪儿点', async () => {
    const view = await buildFileAsk(
      { request: '把 README 发我手机上', query: 'README', deviceId: 'dev-1', computer: 'Ben 的 Mac' },
      {
        scope: async () => ({ authorized: true, roots: [{ path: '/Users/x/Documents', label: '文稿' }], projects: [] }),
        offers: createFileOffers(),
        search: { readdirImpl: deniedReaddir() },
      },
    )
    expect(view.hits).toEqual([])
    expect(view.note).toContain(FILE_ACCESS_DENIED_NOTE)
    // 这一句要说得出"去电脑上哪儿点",不然她在手机上照样不知道该干什么。
    expect(FILE_ACCESS_DENIED_NOTE).toContain('电脑')
    expect(FILE_ACCESS_DENIED_NOTE).toContain('授权')
  })
})

describe('取件那一刻读不动', () => {
  it('★EPERM:说没给授权,**不说「文件已经不在了」**(那是假话)', async () => {
    const root = tempDir()
    const file = join(root, 'README.md')
    writeFileSync(file, '# x\n')
    // 真造一个读不动:把文件放进一个 chmod 000 的目录,lstat 它就是 EACCES。
    const locked = join(root, 'locked')
    mkdirSync(locked)
    const inside = join(locked, 'README.md')
    writeFileSync(inside, '# x\n')
    const { chmodSync } = await import('node:fs')
    chmodSync(locked, 0o000)
    try {
      const result = await checkOfferFile(inside, [root])
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe(FILE_ACCESS_DENIED_NOTE)
      // 403(不是 410):文件在,是权限不够 —— 状态码也不许说成"没了"。
      expect(result.status).toBe(403)
    }
    finally {
      chmodSync(locked, 0o755)
    }
  })

  it('真的不在了:照旧说「已经不在了」', async () => {
    const root = tempDir()
    const result = await checkOfferFile(join(root, '没有这个文件.md'), [root])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(410)
    expect(result.error).toContain('已经不在了')
  })

  it('好好的文件照旧取得到', async () => {
    const root = tempDir()
    const file = join(root, 'README.md')
    writeFileSync(file, '# hello\n')
    expect(await checkOfferFile(file, [root])).toEqual({ ok: true, bytes: 8 })
  })
})
