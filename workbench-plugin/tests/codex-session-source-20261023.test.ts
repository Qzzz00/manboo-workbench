// @vitest-environment node
/**
 * ★ **项目扫描的整片崩口**(2026-10-23 夜,卡 A 验收定位;`docs/交接-1023-协作A同事项接续.md` 最终段):
 * `codexSessionCwds` 自己文件头写着「不能让整批归属因为一份坏文件跟着崩」,但它的第一步
 * `deps.listFiles(codexHome)`(**整批**)不在任何 try 里 —— `~/.codex/sessions` 缺席
 * (没装 Codex 的机器 / 隔离验收 profile)时 readdir 直接抛 ENOENT,buildInner 整段塌,
 * tryCall 一吞,项目区永远空白(scanned_at 落不了账)——派活的「项目目录」跟着没有,
 * 命令行那只手只好如实回「不知道在哪个项目里做」。
 *
 * 修:整批 listFiles 读不到 = 这一支**缺席**,回 `{ items: [], errors: 0 }`(不是错误 ——
 * 没装 Codex 不是用户的错);逐文件那道 try/catch 不变。扫描本身不为缺席的可选来源陪葬。
 */
import { describe, expect, it } from 'vitest'
import { codexSessionCwds } from '../src/server/sessionSources.ts'

const deps = (listFiles: (dir: string) => Promise<string[]>) => ({
  listFiles,
  readFirstLine: async (f: string) => f,
})

describe('codexSessionCwds:整批缺席不陪葬', () => {
  it('★~/.codex/sessions 缺席(ENOENT)→ 空表、零错、不抛', async () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, scandir '/iso/.codex/sessions'"), { code: 'ENOENT' })
    const got = await codexSessionCwds('/iso/.codex', deps(async () => { throw err }))
    expect(got).toEqual({ items: [], errors: 0 })
  })

  it('listFiles 抛别的错(权限/坏盘)也照缺席算:不拖垮整轮项目扫描', async () => {
    const got = await codexSessionCwds('/any', deps(async () => { throw new Error('EPERM: operation not permitted') }))
    expect(got).toEqual({ items: [], errors: 0 })
  })

  it('目录在、文件坏:逐文件挑错的老纪律不动(1 坏 1 好 → items 1、errors 1)', async () => {
    const got = await codexSessionCwds('/iso/.codex', {
      listFiles: async () => ['/a.jsonl', '/b.jsonl'],
      readFirstLine: async (f) => f === '/a.jsonl' ? '{broken' : JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo/x', source: 'cli' } }),
    })
    expect(got.items).toEqual([{ cwd: '/repo/x' }])
    expect(got.errors).toBe(1)
  })
})
