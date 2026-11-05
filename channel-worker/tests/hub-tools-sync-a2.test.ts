/**
 * ★ 电话工人的工具表与 8791 的命令表不许漂(A2,2026-10-28;接缝:8791 接口 `POST /butler/hub/execute`)。
 *
 * 源头在插件(`workbench-plugin/src/server/hub/commands.ts` 的 `HUB_COMMANDS` / `REMEMBER_SCOPES`,
 * `src/protocol.ts` 的 `TASK_STATUSES` / `GOAL_STATUSES`);抄本在工人(`src/hubTools.ts`)。
 * 顶层子目录互不 import,这里读插件源码的文本比对(范本 `layout-kinds-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUB_GOAL_STATUSES, HUB_REMEMBER_SCOPES, HUB_TASK_STATUSES, HUB_TOOL_COMMANDS } from '../src/hubTools.ts'

const PLUGIN = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src')

function listAfter(file: string, pattern: RegExp, what: string): string[] {
  const source = readFileSync(join(PLUGIN, file), 'utf8')
  const hit = source.match(pattern)
  expect(hit, `插件 ${file} 里找不到 ${what} —— 它改名了?这一条要跟着改`).not.toBeNull()
  return [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(one => one[1] as string)
}

/**
 * 没有对应 wb_* 命令工具的四条:ask / chat 是模型自己开口;voice 由工人原有的 wb_set_voice 办
 * (它要先念几个音色给她挑、挑定了当场换,8792 那头的手在工人这边,不经执行口);
 * confirm 是答 8791 挂起的那一问,工人这头走 wb_confirm(执行口的 confirmed 路),不出 confirm 命令工具。
 */
const NOT_TOOLS = ['ask', 'chat', 'voice', 'confirm']

describe('★ 工人工具表 = 8791 命令表(ask / chat 是模型自己开口,voice 走 wb_set_voice)', () => {
  it('命令', () => {
    const plugin = listAfter('server/hub/commands.ts', /export const HUB_COMMANDS = \[([^\]]*)\]/, '`HUB_COMMANDS = [ … ]`')
    expect(plugin).toContain('ask')
    expect([...HUB_TOOL_COMMANDS].sort()).toEqual(plugin.filter(one => !NOT_TOOLS.includes(one)).sort())
  })
  it('规矩的 scope', () => {
    expect([...HUB_REMEMBER_SCOPES]).toEqual(listAfter('server/hub/commands.ts', /export const REMEMBER_SCOPES = \[([^\]]*)\]/, '`REMEMBER_SCOPES`'))
  })
  it('卡与目标的状态', () => {
    expect([...HUB_TASK_STATUSES].sort()).toEqual(listAfter('protocol.ts', /export const TASK_STATUSES: readonly TaskStatus\[\] = \[([^\]]*)\]/, '`TASK_STATUSES`').sort())
    expect([...HUB_GOAL_STATUSES]).toEqual(listAfter('protocol.ts', /export const GOAL_STATUSES: readonly GoalStatus\[\] = \[([^\]]*)\]/, '`GOAL_STATUSES`'))
  })
})
