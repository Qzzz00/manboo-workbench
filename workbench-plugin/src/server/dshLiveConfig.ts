/** 在线配置只经宿主事务写入；离线文件守门仍由 DshSettingsStore 承担。 */
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import { readPatchDefaultModel, readPatchOwnProvider, readPatchRelayProvider, withoutInheritedProviders } from './dshProfilePatch.ts'
import type { DshSettingsEdit } from './dshModelSettings.ts'
import { DSH_OWN_KEY_ENV, DSH_OWN_PROVIDER, DSH_RELAY_PROVIDER, DSH_RELAY_TOKEN_ENV, OWN_DISPLAY_NAME, RELAY_COMPAT, relayModelSpec, relayThinkingLevels } from './dshModelSettings.ts'

export type LiveConfigRollback = (() => Promise<void>) & { previousDefault?: { provider: string, model: string } }
export interface LiveConfigRequest {
  patchPath: string
  text: string
  sourceText?: string
  apply?: (text: string) => DshSettingsEdit
}
export interface ConfigEditorEntryLike {
  options: { id: string, name?: string, config?: unknown }
  fiber?: { state?: number }
}
export interface ConfigEditorLike {
  documentPath?: string
  entries?: () => ConfigEditorEntryLike[]
  edit: (entry: ConfigEditorEntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => Promise<void>
}

/** 完整 currentRawConfig 的非受管字段与继承 provider 均保留。 */
export async function applyLiveModelConfig(editor: ConfigEditorLike | undefined, request: LiveConfigRequest): Promise<LiveConfigRollback> {
  if (editor === undefined) throw new Error('LIVE_CONFIG_EDITOR_UNAVAILABLE')
  if (editor.documentPath === undefined || resolve(editor.documentPath) !== resolve(request.patchPath)) throw new Error('LIVE_CONFIG_PATH_MISMATCH')
  const entryOf = (id: string): ConfigEditorEntryLike => {
    const entry = editor.entries?.().find(one => one.options.id === id)
    if (entry?.fiber?.state !== 2) throw new Error('LIVE_CONFIG_ENTRY_UNAVAILABLE')
    return entry
  }
  // 两项都先检查，缺能力时一个字不写。
  entryOf('llm-pi-ai'); entryOf('agent-default-model')
  const desired = (text: string): { target: { provider: string, model: string }, providers: Record<string, unknown> } => {
    const target = readPatchDefaultModel(text) ?? (entryOf('agent-default-model').options.config as { provider?: string, model?: string } | undefined)
    const own = readPatchOwnProvider(text)
    const relay = readPatchRelayProvider(text)
    if (typeof target?.provider !== 'string' || typeof target.model !== 'string' || !own.ok || !relay.ok) throw new Error('LIVE_CONFIG_INVALID_TARGET')
    const providers: Record<string, unknown> = {}
    if (own.found) providers[DSH_OWN_PROVIDER] = {
      displayName: OWN_DISPLAY_NAME, api: 'openai-completions', baseURL: own.baseUrl,
      apiKeyEnv: DSH_OWN_KEY_ENV, models: [{ id: own.model }],
    }
    if (relay.found) providers[DSH_RELAY_PROVIDER] = {
      displayName: '工作台提供的模型服务', api: 'openai-completions', baseURL: relay.baseUrl,
      apiKeyEnv: DSH_RELAY_TOKEN_ENV,
      compat: Object.fromEntries(RELAY_COMPAT.map(one => [one.key, one.value === 'true' ? true : one.value === 'false' ? false : one.value])),
      models: relay.models.map(id => ({ id,
        ...(relayModelSpec(id).images ? { input: ['text', 'image'] } : {}),
        reasoningEfforts: Object.fromEntries(relayThinkingLevels(id).map(one => [one.level, one.wire ?? null])),
      })),
    }
    return { target: target as { provider: string, model: string }, providers }
  }
  const undo: { id: string, config: Record<string, unknown> }[] = []
  const rollback: LiveConfigRollback = async (): Promise<void> => {
    for (const old of [...undo].reverse()) await editor.edit(entryOf(old.id), () => old.config)
  }
  const beforeDefault = entryOf('agent-default-model').options.config as { provider?: unknown, model?: unknown } | undefined
  if (typeof beforeDefault?.provider === 'string' && typeof beforeDefault.model === 'string') rollback.previousDefault = { provider: beforeDefault.provider, model: beforeDefault.model }
  let next: ReturnType<typeof desired>
  try {
    await editor.edit(entryOf('llm-pi-ai'), (current, inherited) => {
      const inheritedProviders = (inherited.providers ?? {}) as Record<string, unknown>
      const currentProviders = (current.providers ?? {}) as Record<string, unknown>
      const known = Object.keys(currentProviders).filter(name => name !== DSH_OWN_PROVIDER && name !== DSH_RELAY_PROVIDER
        && Object.hasOwn(inheritedProviders, name) && isDeepStrictEqual(currentProviders[name], inheritedProviders[name]))
      const source = withoutInheritedProviders(request.sourceText ?? request.text, known)
      const edited = request.apply?.(source)
      if (edited !== undefined && !edited.ok) throw new Error('LIVE_CONFIG_MANUAL_OR_INVALID')
      next = desired(edited?.text ?? request.text)
      const merged = { ...inherited.providers as object, ...current.providers as object } as Record<string, unknown>
      delete merged[DSH_OWN_PROVIDER]; delete merged[DSH_RELAY_PROVIDER]
      undo.push({ id: 'llm-pi-ai', config: structuredClone(current) })
      return { ...current, providers: { ...merged, ...next.providers } }
    })
    await editor.edit(entryOf('agent-default-model'), current => {
      undo.push({ id: 'agent-default-model', config: structuredClone(current) })
      return { ...current, provider: next.target.provider, model: next.target.model }
    })
  }
  catch (error) {
    // 当前失败的 edit 自己回滚；此前完成的另一项也经同一 API 恢复。
    await rollback()
    throw error
  }
  return rollback
}
