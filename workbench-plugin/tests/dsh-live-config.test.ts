// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyLiveModelConfig, type ConfigEditorLike, type ConfigEditorEntryLike } from '../src/server/dshLiveConfig.ts'
import { patchForOwnEndpoint, PATCH_MODEL_DEFAULTS } from '../src/server/dshProfilePatch.ts'

const patchPath = '/isolated/profiles/web/cordis.patch.yml'
function request() {
  const built = patchForOwnEndpoint('[]\n', { baseUrl: 'http://127.0.0.1:18993/v1', model: 'qa-brain-b', ...PATCH_MODEL_DEFAULTS })
  if (!built.ok) throw new Error('bad fixture')
  return { patchPath, text: built.text }
}
function editorFixture() {
  const inherited = { providers: { 'user-provider': { models: [{ id: 'manual-model' }] } } }
  const configs: Record<string, Record<string, unknown>> = {
    'llm-pi-ai': { providers: { ...inherited.providers, 'workbench-own': { models: [{ id: 'qa-brain-a' }] } } },
    'agent-default-model': { provider: 'workbench-own', model: 'qa-brain-a', reasoningEffort: 'off' },
  }
  let entries = Object.keys(configs).map(id => ({ options: { id, config: configs[id] }, fiber: { state: 2 } }))
  const editor: ConfigEditorLike = {
    documentPath: patchPath,
    entries() { if (this !== editor) throw new Error('lost receiver'); return entries },
    async edit(entry, change) {
      if (this !== editor || !entries.includes(entry as typeof entries[number])) throw new Error('stale entry or receiver')
      const next = change(structuredClone(configs[entry.options.id]!), inherited)
      await Promise.resolve()
      configs[entry.options.id] = next
      // 模拟 Loader 刷新 entry，第二项与回滚必须重新查当前 entry。
      entries = entries.map(one => ({ ...one, options: { ...one.options, config: configs[one.options.id] } }))
    },
  }
  return { editor, configs }
}

describe('ConfigEditor 的完整应用契约', () => {
  it('await 当前 entry 的真实改值，保留 receiver、非受管 provider、其它 raw 字段', async () => {
    const { editor, configs } = editorFixture()
    await applyLiveModelConfig(editor, request())
    expect(configs['llm-pi-ai']!.providers).toMatchObject({
      'user-provider': { models: [{ id: 'manual-model' }] },
      'workbench-own': { baseURL: 'http://127.0.0.1:18993/v1', models: [{ id: 'qa-brain-b' }] },
    })
    expect(configs['agent-default-model']).toEqual({ provider: 'workbench-own', model: 'qa-brain-b', reasoningEffort: 'off' })
  })
  it('后续会话校验失败时，返还的 rollback 恢复两项原配置而非重新推导默认模型', async () => {
    const { editor, configs } = editorFixture()
    const before = structuredClone(configs)
    const rollback = await applyLiveModelConfig(editor, request())
    await rollback()
    expect(configs).toEqual(before)
  })
  it.each(['editor', 'llm', 'default', 'inactive', 'path'])('缺 %s 能力时明确失败且不改变配置', async which => {
    const { editor, configs } = editorFixture()
    const before = structuredClone(configs)
    const entries = editor.entries!()
    if (which === 'llm' || which === 'default') editor.entries = () => entries.filter(one => one.options.id !== (which === 'llm' ? 'llm-pi-ai' : 'agent-default-model'))
    if (which === 'inactive') entries[0]!.fiber!.state = 0
    if (which === 'path') editor.documentPath = '/another/profile'
    await expect(applyLiveModelConfig(which === 'editor' ? undefined : editor, request())).rejects.toThrow()
    expect(configs).toEqual(before)
  })
  it('第二项被 Loader 拒绝，第一项经 editor 恢复；同 B 重试必须真正应用', async () => {
    const { editor, configs } = editorFixture()
    const before = structuredClone(configs)
    const edit = editor.edit
    let fail = true
    editor.edit = async function (entry: ConfigEditorEntryLike, change) {
      if (entry.options.id === 'agent-default-model' && fail) { fail = false; throw new Error('Loader rejected') }
      await edit.call(this, entry, change)
    }
    await expect(applyLiveModelConfig(editor, request())).rejects.toThrow('Loader rejected')
    expect(configs).toEqual(before)
    await applyLiveModelConfig(editor, request())
    expect(configs['agent-default-model']!.model).toBe('qa-brain-b')
  })
})
