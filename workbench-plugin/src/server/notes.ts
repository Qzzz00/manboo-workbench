/**
 * 随手记落盘(PRD §5.5:一个框,不分类不打标签;2026-08-25 版面重排补上持久化)。
 *
 * 在此之前随手记只活在前端 useState 里——刷新一下就全没了,"跳走前按一下"这个用法
 * 因此根本不成立。落盘规格跟 dock.json/scenes.json 一致:原子写(tmp + rename)、
 * 容错读(写坏了按空表兜底,不抛)、写队列(load→改→save 不排队会丢更新)。
 *
 * 不分类不打标签是产品决定,不是省事:这里只有 id/text/created_at 三个字段,
 * 不预留 tags/category 之类的字段位——留了迟早会有人往里塞东西。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NoteView } from '../protocol.ts'

export interface NotesFile { version: 1, notes: NoteView[] }

export function defaultNotesFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/notes.json`
}

function emptyNotesFile(): NotesFile {
  return { version: 1, notes: [] }
}

export async function loadNotesFile(file: string): Promise<NotesFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  }
  catch {
    return emptyNotesFile()
  }
  try {
    const parsed = JSON.parse(text) as Partial<NotesFile> | null
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.notes)) return emptyNotesFile()
    return { version: 1, notes: parsed.notes }
  }
  catch {
    return emptyNotesFile() // 写坏了按空表兜底,先例见 dock.ts loadDockFile。
  }
}

export async function saveNotesFile(file: string, data: NotesFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`)
  await rename(tmp, file)
}

export interface NotesService {
  list(): Promise<readonly NoteView[]>
  add(text: string): Promise<NoteView>
  remove(id: string): Promise<boolean>
}

export function createNotesService(opts: { file: string }): NotesService {
  // 写队列,先例见 scenes.ts/dock.ts:load→改→save 不排队会丢更新。
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    async list(): Promise<readonly NoteView[]> {
      return (await loadNotesFile(opts.file)).notes
    },

    add(text: string): Promise<NoteView> {
      const trimmed = text.trim()
      // 空框按一下不该多一条空记录。抛而不是静默返回:调用方(路由)要据此回 400,
      // 静默成功会让界面以为存上了。
      if (trimmed === '') return Promise.reject(new Error('随手记内容不能为空'))
      return enqueueWrite(async () => {
        const data = await loadNotesFile(opts.file)
        const note: NoteView = { id: randomUUID(), text: trimmed, created_at: new Date().toISOString() }
        // 最新的在最前:随手记是"跳走前按一下",最近写的最该先看到。
        data.notes = [note, ...data.notes]
        await saveNotesFile(opts.file, data)
        return note
      })
    },

    remove(id: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const data = await loadNotesFile(opts.file)
        const before = data.notes.length
        data.notes = data.notes.filter(note => note.id !== id)
        if (data.notes.length === before) return false // 删不存在的:如实返回 false,不抛
        await saveNotesFile(opts.file, data)
        return true
      })
    },
  }
}
