/**
 * **回答账落盘那两下**(2026-10-04,卡 `claude/answer-comes-to-her`;
 * 做法与纪律逐条照 `fileDeliveryFile.ts`,理由在那个文件头)。
 *
 * 为什么这一本也要落盘:「她看过了没有」跨重启。工作台重启一次就忘干净的话,
 * 她看过的那条回答会**又推一次通知**(而她已经读过了),或者反过来 ——
 * 还没看的那条从字幕里消失,答案第二次找不到她。那正是这张卡要治的病。
 *
 * - **老数据读得懂**:没有的格一律当缺席,看不懂的那一条**丢掉**(不编一个);
 *   整份文件读不出来就从空的开始,**不抛**。
 * - 写**同步**、先写旁边再改名盖上去(写一半断电时原来那一份还在)。
 * - 与 `file-delivery.json` / `call-out.json` / `tasks.json` 同一个目录:`~/.dsh/workbench/`。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AnswerView, ButlerRuleChannel } from '../protocol.ts'
import type { DirectAnswerFile, DirectAnswerPersist } from './directAnswer.ts'
import { BUTLER_RULE_CHANNELS } from '../protocol.ts'

/** 账落在哪。 */
export function defaultDirectAnswerFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/direct-answers.json`
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}



/**
 * 一行 → 一条回答。**认不出来就丢**。
 *
 * 必有的三格:id、答案原文、时刻。少了 id 它挂不到任何地方;少了答案这一条没有内容
 * (留着就是一行空字幕);少了时刻过期与排序都判不了。
 * 她问的那一句缺席时按空串读回 —— 问句丢了答案还在,**答案是要紧的那一半**。
 */
export function parseAnswerRow(raw: unknown): AnswerView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const id = text(row.id)
  const answer = text(row.answer)
  const at = text(row.at)
  if (id === undefined || answer === undefined || at === undefined) return undefined
  if (!Number.isFinite(Date.parse(at))) return undefined
  const where = text(row.where)
  return {
    id,
    question: text(row.question) ?? '',
    answer,
    at,
    ...(text(row.task_id) === undefined ? {} : { task_id: text(row.task_id)! }),
    ...(text(row.session_id) === undefined ? {} : { session_id: text(row.session_id)! }),
    ...(where !== undefined && (BUTLER_RULE_CHANNELS as readonly string[]).includes(where) ? { where: where as ButlerRuleChannel } : {}),
    ...(text(row.seen_at) === undefined ? {} : { seen_at: text(row.seen_at)! }),
  }
}

/** 整份文件 → 那几条。看不懂的整份当空的(**不抛**)。 */
export function parseDirectAnswerFile(raw: unknown): readonly AnswerView[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rows = (raw as Record<string, unknown>).answers
  if (!Array.isArray(rows)) return []
  return rows.flatMap((one) => {
    const parsed = parseAnswerRow(one)
    return parsed === undefined ? [] : [parsed]
  })
}

export function directAnswerFileOf(answers: readonly AnswerView[]): DirectAnswerFile {
  return { version: 1, answers }
}

export function createDirectAnswerPersist(path: string): DirectAnswerPersist {
  return {
    load() {
      try { return parseDirectAnswerFile(JSON.parse(readFileSync(path, 'utf8'))) }
      catch { return undefined }
    },
    save(answers) {
      try { mkdirSync(dirname(path), { recursive: true }) }
      catch { /* 目录本来就在 */ }
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(directAnswerFileOf(answers), null, 2)}\n`, 'utf8')
      renameSync(tmp, path)
    },
  }
}
