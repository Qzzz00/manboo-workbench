/**
 * ★ **电话派活负责人不许再写死**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:插件那边的 `AgentDispatchFamily` 在 2026-09-25(卡 Z)就删了写死的名单、
 * 改成**开集**(`type AgentDispatchFamily = string`,登记表里接上哪家就是哪家),
 * 而工人这边还留着 2026-09-24 的 `ITEM_ASSIGNEES = ['codex','claude','kimi','gpt','doubao',
 * 'muse','manus','dsh']`,注释还写着「值域与 8791 的 TaskAssignee 一字不差」—— 已过时。
 * 电话里模型调派活工具时,assignee 只能从那 8 家里挑,新家永远填不进去。
 *
 * 对齐口径(**与插件一致,接受任意字符串**):工人这份 `ItemAssignee = string`(开集),
 * 不再有 `ITEM_ASSIGNEES` 写死表;`itemAssigneeOf` 对任意非空字符串都收(归一化照旧:
 * trim + 小写),只有空的、不是字符串的才算「没点名」。工具 schema 上 assignee 也不挂 enum。
 *
 * 这一份**读插件源码**钉住插件那份是开集,同时钉住工人这份与它同档
 * (顶层子目录互不 import,只能读文本;范本 `calendar-note-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itemAssigneeOf } from '../src/workbench.ts'

const PLUGIN_PROTOCOL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts')
const WORKER_WORKBENCH = join(import.meta.dirname, '..', 'src', 'workbench.ts')
const WORKER_TOOLS = join(import.meta.dirname, '..', 'src', 'tools.ts')

describe('★ 电话派活负责人:插件那份是开集,工人这份不再写死 8 家', () => {
  it('插件 AgentDispatchFamily = string(开集,登记表说谁在就是谁在)', () => {
    const source = readFileSync(PLUGIN_PROTOCOL, 'utf8')
    const hit = source.match(/export type AgentDispatchFamily = ([^\n]+)/)
    expect(hit, '插件 protocol.ts 里找不到 `export type AgentDispatchFamily = …` —— 它改名了?这一条要跟着改').not.toBeNull()
    expect(hit?.[1]?.trim()).toBe('string')
  })

  it('★ 工人 ItemAssignee = string(与插件同一档,不再写死 8 家)', () => {
    const source = readFileSync(WORKER_WORKBENCH, 'utf8')
    const hit = source.match(/export type ItemAssignee = ([^\n]+)/)
    expect(hit, '工人 workbench.ts 里找不到 `export type ItemAssignee = …` —— 它改名了?这一条要跟着改').not.toBeNull()
    expect(hit?.[1]?.trim()).toBe('string')
  })

  it('★ 任意字符串都收(新家名不再被当成「没点名」);空的 / 非字符串才算没点名', () => {
    expect(itemAssigneeOf('some-brand-new-family')).toBe('some-brand-new-family')
    expect(itemAssigneeOf(' Gemini ')).toBe('gemini')
    expect(itemAssigneeOf('Doubao')).toBe('doubao')
    for (const value of ['', '  ', null, undefined, 7, {}]) {
      expect(itemAssigneeOf(value)).toBeUndefined()
    }
  })

  it('★ 工人那份不再有 ITEM_ASSIGNEES 写死表;派活工具的 assignee 不再挂 enum', () => {
    const workbench = readFileSync(WORKER_WORKBENCH, 'utf8')
    expect(workbench, '工人 workbench.ts 里不该再有 `ITEM_ASSIGNEES = [\'codex\'…]` 写死表 —— 以插件为源头改成开集').not.toMatch(/ITEM_ASSIGNEES\s*=\s*\['codex'/)
    const tools = readFileSync(WORKER_TOOLS, 'utf8')
    expect(tools, '工人 tools.ts 派活工具的 assignee 不该再挂 enum —— 接受任意字符串').not.toMatch(/enum:\s*\[\.\.\.ITEM_ASSIGNEES\]/)
  })
})
