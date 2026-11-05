/**
 * ★ **它自己的记录**这条通道:只读一眼那一轮的回答(2026-10-09,卡「千问派活收回答」;
 * 根治方案 `docs/设计-各家在不在跑以它自己的记录为准-2026-10-08.md` 第一级)。
 *
 * 本机有它自己记录的那几家(`agentRecords.RECORD_SOURCES` 里带 `reply` 的那几行:千问办公的库、
 * Claude / Kimi 的会话记录文件 —— 2026-10-12 起),
 * 派活 / 捎话收回答先从它的库里取:按送进去那句里的记号找到那一轮,收了就回正文,在跑就说在跑。
 * Chromium 系的窗被窗口槽藏起来后辅助功能树停在藏起那一刻,读窗读到的是旧画面 —— 库不受这件事影响。
 *
 * 只会**读**:送 / 点 / 停一样都不会(那些照旧走窗口那一条)。读不了(库缺席、表变了、
 * 库里还没那一句)回 `unsupported`,引擎换到读窗口那一条(兜底;`Engine.read` 那一处换路)。
 * 契约里早有这一种通道(`via:'file'`「记录文件」),读的时候排在窗口前(`registry.comparePicks`)。
 * 判断里不写包名:这一家归哪几个包由接线那一处按家族目录算好再给。
 */
import type { AgentRecordReaders } from '../../agentRecords.ts'
import { relayReadMark } from '../../sessionRelay.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../adapter.ts'
import { READ_BUSY_WHY } from './window.ts'

/** 库读不了(缺席 / 表的样子变了 / 出现没见过的状态)那一句。 */
export const RECORDS_UNREADABLE_WHY = '它自己的记录这会儿读不了 —— 改看它的窗口'
/** 库里还没有我们那一句那一句(还没落盘,或者字还在框里)。 */
export const RECORDS_NOT_YET_WHY = '它的记录里还没有这一句 —— 改看它的窗口'
/** 这一轮收了、可一个字都没写出来(多半是被停掉了)。 */
export const RECORDS_NO_TEXT_WHY = '这一轮收了,可它没写出字(可能被停掉了)—— 去它那里看一眼'
/** 只会读,不会送那一句(这条通道不会进送话的队,只是契约要一个 `run`)。 */
export const RECORDS_READ_ONLY_WHY = '它自己的记录只能读,送话要走它的窗口'

const NOTHING: AdapterCapabilities = { open: false, send: false, read: false, press: false, approve: false, writeAsk: false, stop: false, openSession: false }

export interface RecordsAdapterDeps {
  /** 这一家在这台电脑上可能是哪几个包(接线那一处按家族目录算好;只留有 `reply` 这一路的)。 */
  bundleIds: readonly string[]
  readers: AgentRecordReaders
}

export function createRecordsAdapter(family: string, deps: RecordsAdapterDeps): Adapter {
  /** 这一下该问哪个包:她点名了就只认那一个(不归这条记录管就不读);没点名就挑第一个读得到的。 */
  const bundleFor = (named: string | undefined): string | undefined => {
    if (named !== undefined && named.trim() !== '') return deps.bundleIds.includes(named) ? named : undefined
    return deps.bundleIds.find(one => deps.readers.canReply(one)) ?? deps.bundleIds[0]
  }

  async function read(job: Job): Promise<AdapterReadResult> {
    const bundleId = bundleFor(job.package)
    if (bundleId === undefined) return { via: 'file', evidence: 'none', unsupported: true, why: RECORDS_UNREADABLE_WHY }
    // 认那一轮用的记号:调用方记在卡上 / 账上的那个(派活「工作台派活 xxxxxx」、捎话她那句的头一截);没给就取她那句第一行。
    const given = job.marks?.[0]?.trim() ?? ''
    const marker = given !== '' ? given : relayReadMark(job.text)
    // 调用方已认准那一条会话(派活认上的、捎话记下的):只读那一条;有会话记录文件的那几家按它找文件。
    const got = await deps.readers.reply(bundleId, marker, job.target.kind === 'session' ? { sessionId: job.target.sessionId } : undefined)
    if (got === undefined) return { via: 'file', evidence: 'none', unsupported: true, why: RECORDS_UNREADABLE_WHY }
    if (!got.found) return { via: 'file', evidence: 'none', unsupported: true, why: RECORDS_NOT_YET_WHY }
    if (got.status === 'running') return { via: 'file', evidence: 'transcript', busy: true, why: READ_BUSY_WHY }
    if (got.reply === undefined) return { via: 'file', evidence: 'transcript', why: RECORDS_NO_TEXT_WHY }
    return { via: 'file', evidence: 'transcript', reply: got.reply }
  }

  return {
    family,
    via: 'file',
    capabilities: () => Promise.resolve({ ...NOTHING, read: deps.bundleIds.some(one => deps.readers.canReply(one)) }),
    run: () => Promise.resolve<JobResult>({ delivered: 'not_sent', via: 'none', evidence: 'none', unsupported: true, why: RECORDS_READ_ONLY_WHY }),
    read,
  }
}
