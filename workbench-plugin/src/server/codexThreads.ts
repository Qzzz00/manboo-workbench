/**
 * 按名字找 Codex 里的一条会话(2026-09-24 晚,卡 feat/onboarding-materialize)。
 *
 * 维护者:「Codex 已经在『工作台』项目里一条叫『参赛网页』的会话在做」—— 落地的第一件要接着那条做。
 * 这里只**读**:`~/.codex/session_index.jsonl`(每行 `{ id, thread_name, updated_at }`)按名字挑,
 * 再看 `~/.codex/sessions/<年>/<月>/<日>/` 里有没有这条会话的记录文件、最后一次写在什么时候 ——
 * 几条都像时,挑记录最新的那条(「完成参赛网页开发」没有记录文件,「制作参赛网页」今天还在写)。
 * 不打开会话记录本身(那个文件可能几百兆),不改任何东西。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface CodexThreadRow { id: string, title: string, updated_at?: string }

/** session_index.jsonl → 行。坏行跳过。 */
export function parseSessionIndex(text: string): CodexThreadRow[] {
  const out: CodexThreadRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { id?: unknown, thread_name?: unknown, updated_at?: unknown }
      if (typeof row.id !== 'string' || typeof row.thread_name !== 'string' || row.thread_name.trim() === '') continue
      out.push({ id: row.id, title: row.thread_name.trim(), ...(typeof row.updated_at === 'string' ? { updated_at: row.updated_at } : {}) })
    }
    catch { /* 一行坏的不影响别的 */ }
  }
  return out
}

const norm = (text: string): string => text.toLowerCase().replace(/[\s\-_·,,。「」"']+/g, '')

/** 名字里带着 query 的那几条(同一个 id 取最后那一行 —— 改过名的以新名为准)。 */
export function matchThreads(rows: readonly CodexThreadRow[], query: string): CodexThreadRow[] {
  const q = norm(query)
  if (q === '') return []
  const byId = new Map<string, CodexThreadRow>()
  for (const row of rows) byId.set(row.id, row)
  return [...byId.values()].filter(row => norm(row.title).includes(q))
}

export async function findCodexThread(query: string, codexHome: string, now: () => number = Date.now): Promise<{ id: string, title: string } | undefined> {
  let text: string
  try { text = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8') }
  catch { return undefined }
  const matches = matchThreads(parseSessionIndex(text), query)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return { id: (matches[0] as CodexThreadRow).id, title: (matches[0] as CodexThreadRow).title }
  const touched = await rolloutTimes(codexHome, matches.map(one => one.id), now())
  const ranked = [...matches].sort((a, b) => {
    const ta = touched.get(a.id) ?? -1
    const tb = touched.get(b.id) ?? -1
    if (ta !== tb) return tb - ta
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
  })
  const best = ranked[0] as CodexThreadRow
  return { id: best.id, title: best.title }
}

/** 最近 45 天的日期目录里,这几条会话记录文件最后一次写入的时刻(毫秒)。找不到的缺席。 */
async function rolloutTimes(codexHome: string, ids: readonly string[], nowMs: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const root = join(codexHome, 'sessions')
  for (let back = 0; back < 45 && out.size < ids.length; back += 1) {
    const day = new Date(nowMs - back * 86_400_000)
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names: string[]
    try { names = await readdir(dir) }
    catch { continue }
    for (const id of ids) {
      if (out.has(id)) continue
      const name = names.find(one => one.endsWith(`${id}.jsonl`))
      if (name === undefined) continue
      try { out.set(id, (await stat(join(dir, name))).mtimeMs) }
      catch { /* 读不到就当没有 */ }
    }
  }
  return out
}
