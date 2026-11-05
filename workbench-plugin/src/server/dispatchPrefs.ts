/**
 * 偏好:办完提醒的范围 + 桌面活直派(2026-10-23,卡「分层第二刀一」前两条)。
 *
 * 她 10-03 在产物上改的两样 —— 「扩大哪几类事项办完要告诉她」「桌面那一类不问就派」——
 * 都是改产物才能改的东西;这张卡把它们开成设置项,落一份小文件 `~/.dsh/workbench/dispatch-prefs.json`:
 *
 *   - `tell_scope`:哪几类事项办完要告诉她(交办 / 派活 / 会议 / 例程)。**判定留本体不动**
 *     (算不算失败、谁的会话收尾照旧);开关只在出事件那一处读(`callOut.ts` 的 `callOutEventsOf`)。
 *     缺省照 2026-10-23 之前的行为:交办 / 会议 / 例程提醒,派出去的活不提醒。
 *   - `auto_desk`:「桌面那一类不问就派」。缺省关 = 「先问我」档照旧由事务官先接手;
 *     只在 `/butler/item` 现有那道门读(四道门归一是这张卡明确不做的)。
 *
 * 纪律照 rules.ts:写家目录的路径是注入的;文件坏了 / 没有 = 缺省,不抛。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DISPATCH_PREFS_DEFAULT, TELL_SCOPE_DEFAULT,
  type DispatchPrefsView, type TellScopeView,
} from '../protocol.ts'
import { defaultUserLayerPrefsDir } from './userLayer.ts'

/** 派活偏好的真源(2026-10-26 切割收尾):`~/.dsh/workbench/用户层/偏好/dispatch-prefs.json`(老位置 ~/.dsh/workbench/dispatch-prefs.json 一次性迁进,不再读)。 */
export function defaultDispatchPrefsFile(home = process.env.HOME ?? ''): string {
  return join(defaultUserLayerPrefsDir(home), 'dispatch-prefs.json')
}

/** 原始值 → 范围:缺格 / 错类型按缺省补,不认的键不炸。 */
export function parseTellScope(raw: unknown): TellScopeView {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    mine: typeof body.mine === 'boolean' ? body.mine : TELL_SCOPE_DEFAULT.mine,
    dispatch: typeof body.dispatch === 'boolean' ? body.dispatch : TELL_SCOPE_DEFAULT.dispatch,
    meeting: typeof body.meeting === 'boolean' ? body.meeting : TELL_SCOPE_DEFAULT.meeting,
    routine: typeof body.routine === 'boolean' ? body.routine : TELL_SCOPE_DEFAULT.routine,
  }
}

/** 原始值 → 偏好:读不懂 = 缺省。 */
export function parseDispatchPrefs(raw: unknown): DispatchPrefsView {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    tell_scope: parseTellScope(body.tell_scope),
    auto_desk: typeof body.auto_desk === 'boolean' ? body.auto_desk : DISPATCH_PREFS_DEFAULT.auto_desk,
  }
}

export interface DispatchPrefsService {
  load: () => Promise<void>
  view: () => DispatchPrefsView
  /** 合并存:只给哪几格就动哪几格,别的照旧。 */
  save: (next: { tell_scope?: Partial<TellScopeView>, auto_desk?: boolean }) => Promise<DispatchPrefsView>
}

export function createDispatchPrefsService(options: { file: string }): DispatchPrefsService {
  let state: DispatchPrefsView = DISPATCH_PREFS_DEFAULT
  return {
    async load() {
      try { state = parseDispatchPrefs(JSON.parse(await readFile(options.file, 'utf8'))) }
      catch { state = DISPATCH_PREFS_DEFAULT }
    },
    view: () => state,
    async save(next) {
      state = parseDispatchPrefs({
        ...state,
        ...(next.tell_scope === undefined ? {} : { tell_scope: { ...state.tell_scope, ...next.tell_scope } }),
        ...(next.auto_desk === undefined ? {} : { auto_desk: next.auto_desk }),
      })
      await mkdir(dirname(options.file), { recursive: true })
      await writeFile(options.file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      return state
    },
  }
}
