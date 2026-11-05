import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNotesService, loadNotesFile } from '../src/server/notes.ts'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'wb-notes-')), 'notes.json')
}

describe('随手记落盘(2026-08-25 版面重排:刷新就没了这件事本期修掉)', () => {
  it('add → list 拿得到,text 原样,带 id 与 created_at', async () => {
    const svc = createNotesService({ file: tempFile() })
    const note = await svc.add('  记一句  ')
    expect(note.text).toBe('记一句') // 首尾空白去掉,中间原样
    expect(note.id).not.toBe('')
    expect(Number.isNaN(Date.parse(note.created_at))).toBe(false)
    expect(await svc.list()).toEqual([note])
  })

  it('最新的在最前(随手记是"跳走前按一下",最近写的最该先看到)', async () => {
    const svc = createNotesService({ file: tempFile() })
    await svc.add('第一条')
    await svc.add('第二条')
    expect((await svc.list()).map(n => n.text)).toEqual(['第二条', '第一条'])
  })

  it('关掉服务用同一个文件重建实例 → 记录仍在(真的落盘,不是内存残留)', async () => {
    const file = tempFile()
    await createNotesService({ file }).add('活过重启')
    expect((await createNotesService({ file }).list()).map(n => n.text)).toEqual(['活过重启'])
  })

  it('remove 按 id 删,删不存在的返回 false 而不是抛', async () => {
    const svc = createNotesService({ file: tempFile() })
    const note = await svc.add('删我')
    expect(await svc.remove(note.id)).toBe(true)
    expect(await svc.list()).toEqual([])
    expect(await svc.remove(note.id)).toBe(false)
  })

  it('空白 text 不入库(按一下空框不该多一条空记录)', async () => {
    const svc = createNotesService({ file: tempFile() })
    await expect(svc.add('   ')).rejects.toThrow()
    expect(await svc.list()).toEqual([])
  })

  it('文件写坏了 → 按空表兜底,不抛(容错读,先例见 dock.ts)', async () => {
    const file = tempFile()
    writeFileSync(file, '{ 这不是 JSON')
    expect(await loadNotesFile(file)).toEqual({ version: 1, notes: [] })
    expect(await createNotesService({ file }).list()).toEqual([])
  })

  it('并发 add 不丢更新(写队列)', async () => {
    const svc = createNotesService({ file: tempFile() })
    await Promise.all([svc.add('a'), svc.add('b'), svc.add('c')])
    expect(await svc.list()).toHaveLength(3)
  })
})
