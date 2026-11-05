// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createModelService } from '../src/server/modelService.ts'
import { createDshSettingsStore } from '../src/server/dshSettingsStore.ts'
import { applyLiveModelConfig, type ConfigEditorEntryLike } from '../src/server/dshLiveConfig.ts'
import { readPatchDefaultModel, readPatchRelayProvider } from '../src/server/dshProfilePatch.ts'
import { retargetManagedSessions } from '../src/server/modelRetarget.ts'

// 仍操作真实文件；只将事务用到的 FS await 固定为 microtask，setImmediate 可确定排空，免用计时猜顺序。
vi.mock('node:fs/promises', async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const fs = await import('node:fs')
  return { ...original,
    readFile: async (...args: Parameters<typeof fs.readFileSync>) => fs.readFileSync(...args),
    writeFile: async (...args: Parameters<typeof fs.writeFileSync>) => fs.writeFileSync(...args),
    mkdir: async (...args: Parameters<typeof fs.mkdirSync>) => fs.mkdirSync(...args),
    chmod: async (...args: Parameters<typeof fs.chmodSync>) => fs.chmodSync(...args),
    stat: async (...args: Parameters<typeof fs.statSync>) => fs.statSync(...args),
  }
})
const harness = process.env.DSH_HARNESS_DIR ?? fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const YAML = createRequire(join(harness, 'packages/boot/config-editor/package.json'))('yaml') as { parse: (text: string) => any, stringify: (value: unknown) => string }
const endpoint = 'http://127.0.0.1:18993/v1'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function fixture(empty = false, inheritedProvider = false) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-apply-boundaries-'))
  const dshHome = join(dir, '.dsh'), patch = join(dshHome, 'profiles/web/cordis.patch.yml'), modelFile = join(dir, 'model.json')
  await mkdir(join(dshHome, 'profiles/web'), { recursive: true }); await writeFile(patch, '[]\n')
  if (!empty) await createDshSettingsStore({ dshHome }).applyOwnKey(undefined, { baseUrl: endpoint, model: 'qa-a' })
  await writeFile(modelFile, JSON.stringify({ mode: 'own', device_id: 'qa-only', own: empty ? {} : { base_url: endpoint, model: 'qa-a' } }))
  const inherited = inheritedProvider ? { providers: { 'manual-provider': { models: [{ id: 'manual-model' }] } } } : {}
  const rows = YAML.parse(await readFile(patch, 'utf8')) as { id: string, config: Record<string, unknown> }[]
  const configs: Record<string, Record<string, unknown>> = {
    'llm-pi-ai': rows.find(r => r.id === 'llm-pi-ai')?.config ?? inherited,
    'agent-default-model': rows.find(r => r.id === 'agent-default-model')?.config ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
  let entries = Object.keys(configs).map(id => ({ options: { id, config: configs[id] }, fiber: { state: 2 } }))
  let fail = false, edits = 0
  const editor = { documentPath: patch, entries: () => entries,
    async edit(entry: ConfigEditorEntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      edits += 1
      if (fail) throw new Error('Loader rejected')
      const id = entry.options.id
      const next = change(structuredClone(configs[id]!), id === 'llm-pi-ai' ? inherited : {})
      configs[id] = next
      const rows = YAML.parse(await readFile(patch, 'utf8')) as { id: string, config: Record<string, unknown> }[]
      const index = rows.findIndex(r => r.id === id)
      if (index < 0) rows.push({ id, config: next }); else rows[index]!.config = next
      await writeFile(patch, YAML.stringify(rows)) // 与正式 editor 一样持久化完整 raw next。
      entries = Object.keys(configs).map(id => ({ options: { id, config: configs[id] }, fiber: { state: 2 } }))
    },
  }
  return { dir, patch, modelFile, configs, inherited, editor, get edits() { return edits }, setFail: (value: boolean) => { fail = value },
    options: { modelFile, credentialFile: join(dir, 'credentials.json'), dshHome, liveReconcile: (request: Parameters<typeof applyLiveModelConfig>[1]) => applyLiveModelConfig(editor, request) },
    close: () => rm(dir, { recursive: true, force: true }),
  }
}

it.each([false, true])('并发 B 与 C，B失败=%s：C等完整事务结束，不被旧回滚覆盖', async failB => {
  const f = await fixture(); const reached = deferred(), release = deferred()
  let cSettled = false
  const order: string[] = []
  try {
    const service = createModelService({ ...f.options, onModelTargetChanged: async change => {
      order.push(change.model!)
      if (change.model === 'qa-b') { reached.resolve(); await release.promise; if (failB) throw new Error('late failure') }
    } })
    const b = service.update({ mode: 'own', own_model: 'qa-b' })
    await reached.promise
    const c = service.update({ mode: 'own', own_model: 'qa-c' }).finally(() => { cSettled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    const beforeRelease = cSettled
    release.resolve()
    const [br, cr] = await Promise.all([b, c])
    expect(beforeRelease).toBe(false)
    expect({ b: br.ok, c: cr.ok }).toEqual({ b: !failB, c: true })
    expect(order).toEqual(['qa-b', 'qa-c'])
    expect(JSON.parse(await readFile(f.modelFile, 'utf8')).own.model).toBe('qa-c')
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))?.model).toBe('qa-c')
    expect((await service.target()).model).toBe('qa-c')
  } finally { release.resolve(); await f.close() }
})
it('继承 provider 完整写回后 B→同B→C 都可应用，原值不变；手工改值仍拒绝', async () => {
  const f = await fixture(false, true)
  try {
    const service = createModelService(f.options)
    for (const model of ['qa-b', 'qa-b', 'qa-c']) {
      expect((await service.update({ mode: 'own', own_model: model })).ok).toBe(true)
      expect((f.configs['llm-pi-ai']!.providers as Record<string, unknown>)['manual-provider']).toEqual(f.inherited.providers!['manual-provider'])
    }
    expect(f.edits).toBe(6)
    const rows = YAML.parse(await readFile(f.patch, 'utf8'))
    rows.find((r: { id: string }) => r.id === 'llm-pi-ai').config.providers['manual-provider'] = { models: [{ id: 'hand-edited' }] }
    await writeFile(f.patch, YAML.stringify(rows))
    f.configs['llm-pi-ai']!.providers = rows.find((r: { id: string }) => r.id === 'llm-pi-ai').config.providers
    expect((await service.update({ mode: 'own', own_model: 'qa-d' })).ok).toBe(false)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))?.model).toBe('qa-c')
  } finally { await f.close() }
})
it('空 patch 使用有效继承默认且同值仍 await；live失败必须失败', async () => {
  const f = await fixture(true)
  try {
    const service = createModelService(f.options)
    expect((await service.update({ mode: 'own' })).ok).toBe(true)
    expect(f.configs['agent-default-model']).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const before = f.edits
    f.setFail(true)
    expect((await service.update({ mode: 'own' })).ok).toBe(false)
    expect(f.edits).toBeGreaterThan(before)
    await expect(service.target()).rejects.toThrow()
  } finally { await f.close() }
})
it('原relay R→own C→relay恢复R，后来手选非受管会话不改派', async () => {
  const f = await fixture(true)
  const sessions = [ { sessionId: 'owned', provider: 'workbench-relay', model: 'deepseek-v4-pro' }, { sessionId: 'manual', provider: 'workbench-relay', model: 'deepseek-v4-pro' } ]
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ token: 'qa-only-fake', used_tokens: 0 }), { status: 200 })
  try {
    await writeFile(f.modelFile, JSON.stringify({ mode: 'relay', relay_url: endpoint, relay_token: 'qa-only-fake', device_id: 'qa-only' }))
    f.configs['agent-default-model'] = { provider: 'workbench-relay', model: 'deepseek-v4-pro' }
    await f.editor.edit(f.editor.entries().find(e => e.options.id === 'agent-default-model')!, () => f.configs['agent-default-model']!)
    const service = createModelService({ ...f.options, fetchImpl, onModelTargetChanged: async change => {
      const fallback = f.configs['agent-default-model'] as { provider: string, model: string }
      return retargetManagedSessions({ selections: async () => sessions, catalogDefault: async () => fallback, change,
        opener: { retarget: async (id, provider, model) => { Object.assign(sessions.find(s => s.sessionId === id)!, { provider, model }); return true } },
      })
    } })
    expect((await service.update({ mode: 'own', own_base_url: endpoint, own_model: 'qa-c' })).ok).toBe(true)
    Object.assign(sessions[1]!, { provider: 'manual-provider', model: 'qa-c' }) // own成功后用户另选。
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toMatchObject({ provider: 'workbench-relay', model: 'deepseek-v4-pro' })
    const relay = readPatchRelayProvider(await readFile(f.patch, 'utf8'))
    expect(relay.ok && relay.found && relay.models.includes('qa-c')).toBe(false)
    expect(sessions).toEqual([ { sessionId: 'owned', provider: 'workbench-relay', model: 'deepseek-v4-pro' }, { sessionId: 'manual', provider: 'manual-provider', model: 'qa-c' } ])
  } finally { await f.close() }
})

it('只补令牌也排在设置事务之后，从最终B读取，不丢新选择或新令牌', async () => {
  const f = await fixture(); const reached = deferred(), release = deferred()
  try {
    const disk = JSON.parse(await readFile(f.modelFile, 'utf8'))
    await writeFile(f.modelFile, JSON.stringify({ ...disk, relay_url: endpoint }))
    const service = createModelService({ ...f.options,
      fetchImpl: async () => new Response(JSON.stringify({ token: 'qa-only-issued' }), { status: 200 }),
      onModelTargetChanged: async () => { reached.resolve(); await release.promise },
    })
    const b = service.update({ mode: 'own', own_model: 'qa-b' })
    await reached.promise
    let tokenSettled = false
    const token = service.ensureDeviceToken().finally(() => { tokenSettled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    const beforeRelease = tokenSettled
    release.resolve()
    expect((await b).ok).toBe(true)
    expect((await token).ok).toBe(true)
    expect(beforeRelease).toBe(false)
    const final = JSON.parse(await readFile(f.modelFile, 'utf8'))
    expect(final.own.model).toBe('qa-b')
    expect(final.relay_token).toBe('qa-only-issued')
  } finally { release.resolve(); await f.close() }
})

it('没有可靠原选择的已有own配置切relay用既有标准目标，不把own A/B注册进去', async () => {
  const f = await fixture()
  try {
    const service = createModelService({ ...f.options, fetchImpl: async () => new Response(JSON.stringify({ token: 'qa-only-issued' }), { status: 200 }) })
    expect((await service.update({ mode: 'own', own_model: 'qa-b' })).ok).toBe(true)
    expect(JSON.parse(await readFile(f.modelFile, 'utf8')).dsh_prev_model).toBeUndefined()
    expect((await service.update({ mode: 'relay', relay_url: endpoint })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-flash' })
    const relay = readPatchRelayProvider(await readFile(f.patch, 'utf8'))
    expect(relay.ok && relay.found && relay.models.some(id => id === 'qa-a' || id === 'qa-b')).toBe(false)
  } finally { await f.close() }
})
it('非继承的真实手工provider仍拒写，不借在线回调放宽守门', async () => {
  const f = await fixture()
  try {
    const rows = YAML.parse(await readFile(f.patch, 'utf8'))
    const providers = rows.find((r: { id: string }) => r.id === 'llm-pi-ai').config.providers
    providers['user-added'] = { models: [{ id: 'manual-model' }] }
    f.configs['llm-pi-ai']!.providers = providers
    await writeFile(f.patch, YAML.stringify(rows))
    const before = await readFile(f.patch, 'utf8')
    expect((await createModelService(f.options).update({ mode: 'own', own_model: 'qa-b' })).ok).toBe(false)
    expect(await readFile(f.patch, 'utf8')).toBe(before)
  } finally { await f.close() }
})


// 使用真实 profile/default entry 写入，表示用户修改已被 Loader 接受；不是只改 session selection。
async function selectDefault(f: Awaited<ReturnType<typeof fixture>>, model: string) {
  await f.editor.edit(f.editor.entries().find(e => e.options.id === 'agent-default-model')!, () => ({ provider: 'workbench-relay', model }))
}
async function relayFixture() {
  const f = await fixture(true)
  await writeFile(f.modelFile, JSON.stringify({ mode: 'relay', relay_url: endpoint, relay_token: 'qa-only-fake', device_id: 'qa-only' }))
  await selectDefault(f, 'deepseek-v4-flash')
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ used_tokens: 0 }), { status: 200 })
  return { ...f, options: { ...f.options, fetchImpl } }
}

it('两轮relay/own：本轮连续换own仍回原选择，下轮保留用户新默认与手选会话', async () => {
  const f = await relayFixture()
  const sessions = [
    { sessionId: 'owned', provider: 'workbench-relay', model: 'deepseek-v4-flash' },
    { sessionId: 'manual', provider: 'workbench-relay', model: 'deepseek-v4-flash' },
  ]
  try {
    const service = createModelService({ ...f.options, onModelTargetChanged: async change => {
      return retargetManagedSessions({ selections: async () => sessions,
        catalogDefault: async () => f.configs['agent-default-model'] as { provider: string, model: string }, change,
        opener: { retarget: async (id, provider, model) => { Object.assign(sessions.find(s => s.sessionId === id)!, { provider, model }); return true } },
      })
    } })
    for (const model of ['qa-a', 'qa-b', 'qa-c']) {
      expect((await service.update({ mode: 'own', own_base_url: endpoint, own_model: model })).ok).toBe(true)
    }
    Object.assign(sessions[1]!, { provider: 'manual-provider', model: 'manual-model' })
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-flash' })
    await selectDefault(f, 'deepseek-v4-pro')
    expect(f.configs['agent-default-model']).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-pro' })
    for (const model of ['qa-d', 'qa-e']) {
      expect((await service.update({ mode: 'own', own_base_url: endpoint, own_model: model })).ok).toBe(true)
    }
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-pro' })
    expect(sessions).toEqual([
      { sessionId: 'owned', provider: 'workbench-relay', model: 'deepseek-v4-pro' },
      { sessionId: 'manual', provider: 'manual-provider', model: 'manual-model' },
    ])
    const relay = readPatchRelayProvider(await readFile(f.patch, 'utf8'))
    expect(relay.ok && relay.found && relay.models.some(id => id.startsWith('qa-'))).toBe(false)
  } finally { await f.close() }
})

it.each([
  ['own', 'live'], ['own', 'session'], ['own', 'save'],
  ['relay', 'live'], ['relay', 'session'], ['relay', 'save'],
] as const)('第二周期切%s在%s失败：回滚保持当轮来源，重试恢复用户新默认', async (mode, stage) => {
  const f = await relayFixture()
  let failSession = false
  const fs = await import('node:fs/promises')
  const originalWriteFile = fs.writeFile
  let writeSpy: ReturnType<typeof vi.spyOn> | undefined
  try {
    const service = createModelService({ ...f.options, onModelTargetChanged: async () => {
      if (failSession) throw new Error('session selection rejected')
    } })
    expect((await service.update({ mode: 'own', own_base_url: endpoint, own_model: 'qa-c' })).ok).toBe(true)
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    await selectDefault(f, 'deepseek-v4-pro')
    const ownPatch = { mode: 'own' as const, own_base_url: endpoint, own_model: 'qa-d' }
    if (mode === 'relay') expect((await service.update(ownPatch)).ok).toBe(true)
    const beforeFile = await readFile(f.modelFile, 'utf8')
    const beforeDefault = { ...f.configs['agent-default-model'] }
    if (stage === 'live') f.setFail(true)
    if (stage === 'session') failSession = true
    if (stage === 'save') writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (file === f.modelFile) throw new Error('model save rejected')
      return originalWriteFile(file, data, options)
    })
    const attempt = mode === 'own' ? ownPatch : { mode: 'relay' as const }
    expect((await service.update(attempt)).ok).toBe(false)
    expect(await readFile(f.modelFile, 'utf8')).toBe(beforeFile)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toEqual(beforeDefault)
    expect(f.configs['agent-default-model']).toEqual(beforeDefault)
    await expect(service.target()).rejects.toThrow()
    f.setFail(false); failSession = false; writeSpy?.mockRestore()
    expect((await service.update(attempt)).ok).toBe(true)
    if (mode === 'own') expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patch, 'utf8'))).toEqual({ provider: 'workbench-relay', model: 'deepseek-v4-pro' })
  } finally { writeSpy?.mockRestore(); await f.close() }
})
