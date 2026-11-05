// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createModelService } from '../src/server/modelService.ts'
import { createButlerSessionOpener } from '../src/index.ts'
import { createDshSessionFeed } from '../src/server/dshSessionFeed.ts'
import { retargetManagedSessions } from '../src/server/modelRetarget.ts'
import { applyLiveModelConfig, type ConfigEditorLike } from '../src/server/dshLiveConfig.ts'
import { OWN_DEFAULT_BASE_URL } from '../src/server/modelConfig.ts'
import { parseProfilePatch, patchForOwnEndpoint, patchForOwnModel, patchForRelay, PATCH_MODEL_DEFAULTS, readPatchDefaultModel, readPatchOwnProvider, readPatchRelayProvider } from '../src/server/dshProfilePatch.ts'

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }))

const harness = process.env.DSH_HARNESS_DIR ?? fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const YAML = createRequire(join(harness, 'packages/boot/config-editor/package.json'))('yaml') as {
  parseDocument: (text: string) => any, isMap: (node: any) => boolean, isSeq: (node: any) => boolean,
}
const relayUrl = 'http://127.0.0.1:18993'
const flash = 'deepseek-v4-flash', pro = 'deepseek-v4-pro'

// 锁定 ConfigEditor 的 AST 与 inherited 深相等删除路径；不模拟 catalog 或上游 Loader。
function persistConfig(text: string, id: string, next: Record<string, unknown>, inherited: Record<string, unknown>) {
  const doc = YAML.parseDocument(text)
  if (doc.errors[0] !== undefined) throw doc.errors[0]
  if (!YAML.isSeq(doc.contents)) throw new Error('Profile patch must be a YAML sequence')
  doc.contents.flow = false
  const index = doc.contents.items.findLastIndex((row: any, i: number) => YAML.isMap(row)
    && doc.getIn([i, 'id']) === id && !row.has('insert'))
  if (isDeepStrictEqual(next, inherited)) {
    for (let i = doc.contents.items.length - 1; i >= 0; i--) {
      const row = doc.contents.items[i]
      if (!YAML.isMap(row) || doc.getIn([i, 'id']) !== id || row.has('insert')) continue
      row.delete('config')
      if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) doc.delete(i)
    }
  }
  else if (index < 0) doc.add(doc.createNode({ id, config: next }))
  else doc.setIn([index, 'config'], doc.createNode(next))
  return String(doc)
}

async function fixture(inherited: Record<string, unknown> = {}, existingEmpty = false) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-empty-providers-'))
  const dshHome = join(dir, '.dsh'), patchPath = join(dshHome, 'profiles/web/cordis.patch.yml'), modelFile = join(dir, 'model.json')
  await mkdir(join(dshHome, 'profiles/web'), { recursive: true })
  let text = persistConfig('[]\n', 'agent-default-model', { provider: 'workbench-relay', model: flash }, {})
  if (existingEmpty) text = persistConfig(text, 'llm-pi-ai', { providers: {} }, {})
  await writeFile(patchPath, text)
  await writeFile(modelFile, JSON.stringify({ mode: 'relay', relay_url: relayUrl, relay_token: 'qa-only-fake', device_id: 'qa-only' }))
  const configs: Record<string, Record<string, unknown>> = {
    'llm-pi-ai': existingEmpty ? { providers: {} } : structuredClone(inherited),
    'agent-default-model': { provider: 'workbench-relay', model: flash },
  }
  let failDefault = false
  const editor: ConfigEditorLike = { documentPath: patchPath,
    entries: () => Object.keys(configs).map(id => ({ options: { id, config: configs[id] }, fiber: { state: 2 } })),
    async edit(entry, change) {
      const id = entry.options.id, base = id === 'llm-pi-ai' ? inherited : {}
      const next = change(structuredClone(configs[id]!), structuredClone(base))
      if (id === 'agent-default-model' && failDefault) { failDefault = false; throw new Error('Loader rejected default') }
      await writeFile(patchPath, persistConfig(await readFile(patchPath, 'utf8'), id, next, base))
      configs[id] = next
    },
  }
  const options = { dshHome, modelFile, credentialFile: join(dir, 'missing.json'),
    fetchImpl: async () => new Response(JSON.stringify({ used_tokens: 0 }), { status: 200 }),
    liveReconcile: (request: Parameters<typeof applyLiveModelConfig>[1]) => applyLiveModelConfig(editor, request),
  }
  return { patchPath, modelFile, configs, options, failNextDefault: () => { failDefault = true },
    close: () => rm(dir, { recursive: true, force: true }) }
}

it.each([{}, { providers: {} }])('正式AST空providers与继承删除语义允许连续标准官方模型更新（inherited=%j）', async inherited => {
  const f = await fixture(inherited)
  try {
    const service = createModelService(f.options)
    for (const model of [flash, pro, pro, flash]) {
      expect((await service.update({ mode: 'own', own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })).ok).toBe(true)
      expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'deepseek-official', model })
      const text = await readFile(f.patchPath, 'utf8')
      if ('providers' in inherited) expect(text).not.toContain('llm-pi-ai')
      else expect(text).toContain('providers: {}')
    }
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'workbench-relay', model: flash })
  } finally { await f.close() }
})

it.each([false, true])('已落盘空providers可重复更新并恢复relay（live=%s）', async live => {
  const f = await fixture({}, true)
  try {
    const service = createModelService({ ...f.options, ...(live ? {} : { liveReconcile: undefined }) })
    for (const model of [pro, pro, flash]) {
      expect((await service.update({ mode: 'own', own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })).ok).toBe(true)
    }
    expect((await service.update({ mode: 'relay' })).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'workbench-relay', model: flash })
    const relay = readPatchRelayProvider(await readFile(f.patchPath, 'utf8'))
    expect(relay.ok && relay.found && relay.models.includes(flash)).toBe(true)
  } finally { await f.close() }
})

it('空providers下第二项失败回滚后同值重试可用，不留半个设置', async () => {
  const f = await fixture({}, true)
  try {
    const service = createModelService(f.options)
    const before = await readFile(f.modelFile, 'utf8')
    f.failNextDefault()
    const patch = { mode: 'own' as const, own_base_url: relayUrl, own_model: pro }
    expect((await service.update(patch)).ok).toBe(false)
    expect(await readFile(f.modelFile, 'utf8')).toBe(before)
    expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'workbench-relay', model: flash })
    expect(f.configs['llm-pi-ai']).toEqual({ providers: {} })
    await expect(service.target()).rejects.toThrow()
    expect((await service.update(patch)).ok).toBe(true)
    expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'workbench-own', model: pro })
  } finally { await f.close() }
})

it('正式AST保留非空继承provider；随后手改值仍拒绝且文件不变', async () => {
  const inherited = { providers: { 'manual-provider': { models: [{ id: 'manual-model' }] } } }
  const f = await fixture(inherited)
  try {
    const service = createModelService(f.options)
    for (const model of [flash, pro]) {
      expect((await service.update({ mode: 'own', own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })).ok).toBe(true)
      expect(f.configs['llm-pi-ai']).toEqual(inherited)
    }
    const manual = { providers: { 'manual-provider': { models: [{ id: 'user-edited' }] } } }
    f.configs['llm-pi-ai'] = manual
    await writeFile(f.patchPath, persistConfig(await readFile(f.patchPath, 'utf8'), 'llm-pi-ai', manual, inherited))
    const before = await readFile(f.patchPath, 'utf8')
    expect((await service.update({ mode: 'own', own_base_url: relayUrl, own_model: 'qa-c' })).ok).toBe(false)
    expect(await readFile(f.patchPath, 'utf8')).toBe(before)
  } finally { await f.close() }
})

it.each(['{}', '{} # editor empty'])('只认llm-pi-ai块式config的直接空providers（%s）', value => {
  const text = `- id: llm-pi-ai\n  config:\n    providers: ${value}\n`
  expect(parseProfilePatch(text).ok).toBe(true)
  expect(readPatchOwnProvider(text)).toEqual({ ok: true, found: false })
  expect(readPatchRelayProvider(text)).toEqual({ ok: true, found: false })
  expect(patchForOwnModel(text, { ...PATCH_MODEL_DEFAULTS, model: pro }).ok).toBe(true)
  expect(patchForOwnEndpoint(text, { ...PATCH_MODEL_DEFAULTS, baseUrl: relayUrl, model: 'qa-c' }).ok).toBe(true)
  expect(patchForRelay(text, { ...PATCH_MODEL_DEFAULTS, baseUrl: relayUrl }).ok).toBe(true)
})

it.each([
  '- id: llm-pi-ai\n  config: {}\n',
  '- id: llm-pi-ai\n  config: {providers: {}}\n',
  '- id: other\n  config:\n    providers: {}\n',
  '- id: llm-pi-ai\n  providers: {}\n',
  '- id: llm-pi-ai\n  config:\n    nested:\n      providers: {}\n',
  '- id: llm-pi-ai\n  config:\n    providers: {manual: {}}\n',
  '- id: llm-pi-ai\n  config:\n    providers:\n      manual: {}\n',
  '- id: llm-pi-ai\n  config:\n    providers: {}\n      manual: 1\n',
  '- id: llm-pi-ai\n  insert: true\n  config:\n    providers: {}\n',
  '- id: llm-pi-ai\n  config:\n    providers: {}\n    providers:\n      manual:\n        model: private\n',
  '- id: llm-pi-ai\n  config:\n    providers: {}\n  config:\n    providers:\n      manual:\n        model: private\n',
  '- id: llm-pi-ai\n  id: other\n  config:\n    providers: {}\n',
])('未知/非空/错层inline mapping不借空providers放行（%s）', text => {
  expect(parseProfilePatch(text).ok).toBe(false)
  expect(patchForOwnModel(text, { ...PATCH_MODEL_DEFAULTS, model: pro }).ok).toBe(false)
  expect(patchForRelay(text, { ...PATCH_MODEL_DEFAULTS, baseUrl: relayUrl }).ok).toBe(false)
})


function sessionFixture(f: Awaited<ReturnType<typeof fixture>>, laggingHeader = false) {
  let feed = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {} })
  const sessions = [
    { sessionId: 'controlled', provider: 'workbench-relay', model: flash },
    { sessionId: 'manual', provider: 'manual-provider', model: flash },
    { sessionId: 'official-other', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
  ]
  const headers = structuredClone(sessions)
  for (const one of headers) feed.handleEvent(one.sessionId, { type: 'request/header', seq: 1, data: { header: { config: one } } })
  const select = (sessionId: string, provider: string, model: string) => {
    Object.assign(sessions.find(one => one.sessionId === sessionId)!, { provider, model })
    // DSH selectModel 只持久化 model/selection；旧 request/header 一直不变。
    feed.handleProjection(sessionId, 'modelSelection', { lastUsed: headers.find(one => one.sessionId === sessionId), next: { provider, model } })
  }
  const prompts: { sessionId: string, provider: string, model: string }[] = []
  let rejectSelection = false, selectionKnown = true, selectCalls = 0, rejectCall = -1
  const defaultModel = async () => f.configs['agent-default-model'] as { provider: string, model: string }
  const options = { ...f.options, onModelTargetChanged: async (change: Parameters<typeof retargetManagedSessions>[0]['change']) => {
    return retargetManagedSessions({ selections: async () => laggingHeader ? feed.selections() : sessions, catalogDefault: defaultModel, opener, change })
  } }
  let service = createModelService(options)
  const opener = createButlerSessionOpener({ on: () => undefined,
    inject: (names: readonly string[], callback: (ctx: never) => void) => {
      if (names[0] === 'sessionController') callback({ sessionController: {
        selectModel: async ({ sessionId, provider, model }: { sessionId: string, provider: string, model: string }) => {
          if (rejectSelection || ++selectCalls === rejectCall) throw new Error('selection rejected')
          select(sessionId, provider, model)
        },
        prompt: async ({ sessionId }: { sessionId: string }) => { prompts.push({ ...sessions.find(one => one.sessionId === sessionId)! }) },
        create: async () => { throw new Error('must keep existing session') },
      } } as never)
    },
  } as never, () => undefined, { target: () => service.target(),
    selectionOf: id => selectionKnown ? (laggingHeader ? feed.selectionOf(id) : sessions.find(one => one.sessionId === id)) : undefined,
    catalogDefault: defaultModel,
  })!
  return { get service() { return service }, get feed() { return feed }, opener, sessions, prompts, select,
    restoreFeed: () => {
      feed = createDshSessionFeed({ applyEvent: () => {}, setMetrics: () => {} })
      for (const one of sessions) feed.handleProjection(one.sessionId, 'modelSelection', { lastUsed: headers.find(old => old.sessionId === one.sessionId), next: one })
    },
    reject: (value: boolean) => { rejectSelection = value }, rejectAfter: (count: number) => { rejectCall = selectCalls + count }, forgetSelections: () => { selectionKnown = false },
    restart: () => { service = createModelService(options) },
  }
}

it('标准flash→pro→relay：每次设置后原会话立即使用新模型，手选provider/其它官方模型不动', async () => {
  const f = await fixture()
  const s = sessionFixture(f)
  try {
    for (const patch of [
      { mode: 'own' as const, own_base_url: OWN_DEFAULT_BASE_URL, own_model: flash },
      { mode: 'own' as const, own_base_url: OWN_DEFAULT_BASE_URL, own_model: pro },
      { mode: 'relay' as const },
    ]) {
      expect((await s.service.update(patch)).ok).toBe(true)
      expect(await s.opener.say!('controlled', 'qa-only')).toBe(true)
    }
    expect(s.prompts).toEqual([
      { sessionId: 'controlled', provider: 'deepseek-official', model: flash },
      { sessionId: 'controlled', provider: 'deepseek-official', model: pro },
      { sessionId: 'controlled', provider: 'workbench-relay', model: flash },
    ])
    expect(s.sessions.slice(1)).toEqual([
      { sessionId: 'manual', provider: 'manual-provider', model: flash },
      { sessionId: 'official-other', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    ])
    expect(JSON.parse(await readFile(f.modelFile, 'utf8')).dsh_prev_model).toBe(flash)
  } finally { await f.close() }
})

it.each(['session', 'save'] as const)('官方模型%s失败阻发并回滚，对齐来源在重试/同值保存/重启后仍正确', async failure => {
  const f = await fixture()
  const s = sessionFixture(f)
  const fs = await import('node:fs/promises')
  const originalWriteFile = fs.writeFile
  let writeSpy: ReturnType<typeof vi.spyOn> | undefined
  try {
    expect((await s.service.update({ mode: 'own', own_base_url: OWN_DEFAULT_BASE_URL, own_model: flash })).ok).toBe(true)
    expect((await s.service.update({ mode: 'own', own_base_url: OWN_DEFAULT_BASE_URL, own_model: pro })).ok).toBe(true)
    const before = await readFile(f.modelFile, 'utf8')
    if (failure === 'session') s.reject(true)
    else writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (file === f.modelFile) throw new Error('save rejected')
      return originalWriteFile(file, data, options)
    })
    const patch = { mode: 'relay' as const }
    expect((await s.service.update(patch)).ok).toBe(false)
    expect(await readFile(f.modelFile, 'utf8')).toBe(before)
    expect(readPatchDefaultModel(await readFile(f.patchPath, 'utf8'))).toEqual({ provider: 'deepseek-official', model: pro })
    expect(await s.opener.say!('controlled', 'must not send')).toBe(false)
    expect(s.prompts).toEqual([])
    s.reject(false); writeSpy?.mockRestore()
    expect((await s.service.update(patch)).ok).toBe(true)
    expect((await s.service.update(patch)).ok).toBe(true)
    s.restart()
    // 宿主恢复的旧选择是官方 pro；来源不能误用原恢复目标 flash，也不能被同值保存或重启丢掉。
    Object.assign(s.sessions[0]!, { provider: 'deepseek-official', model: pro })
    expect(await s.opener.say!('controlled', 'after restart')).toBe(true)
    expect(s.prompts.at(-1)).toEqual({ sessionId: 'controlled', provider: 'workbench-relay', model: flash })
    expect(await s.opener.say!('manual', 'manual unchanged')).toBe(true)
    expect(await s.opener.say!('official-other', 'other unchanged')).toBe(true)
    expect(s.sessions.slice(1)).toEqual([
      { sessionId: 'manual', provider: 'manual-provider', model: flash },
      { sessionId: 'official-other', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    ])
    s.forgetSelections(); Object.assign(s.sessions[0]!, { provider: 'deepseek-official', model: pro })
    expect(await s.opener.say!('controlled', 'unknown selection')).toBe(true)
    expect(s.prompts.at(-1)).toEqual({ sessionId: 'controlled', provider: 'workbench-relay', model: flash })
  } finally { writeSpy?.mockRestore(); await f.close() }
})


it('真实feed的header滞后：官方flash→pro→flash无请求连续设置，pending与恢复投影保护手选', async () => {
  const f = await fixture()
  const s = sessionFixture(f, true)
  try {
    const official = (model: string) => ({ mode: 'own' as const, own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })
    expect((await s.service.update(official('deepseek-flash'))).ok).toBe(true)
    // 第一轮已使用官方 A，之后只选模型、不产生新 request/header。
    s.feed.handleEvent('controlled', { type: 'request/header', seq: 2, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } })
    expect((await s.service.update(official(pro))).ok).toBe(true)
    expect(s.feed.selectionOf('controlled')).toEqual({ provider: 'deepseek-official', model: pro })
    expect(s.feed.usage('controlled')?.model).toBe('deepseek-flash')
    expect((await s.service.update(official('deepseek-flash'))).ok).toBe(true)
    expect(s.sessions[0]?.model).toBe('deepseek-flash')
    expect(s.prompts).toEqual([])
    s.select('manual', 'manual-provider', 'deepseek-flash')
    s.select('official-other', 'deepseek-official', 'other-user-choice')
    s.restart(); s.restoreFeed()
    expect((await s.service.update(official(pro))).ok).toBe(true)
    expect(s.sessions[0]?.model).toBe(pro)
    expect(await s.opener.say!('controlled', 'after restart')).toBe(true)
    expect(s.prompts.at(-1)?.model).toBe(pro)
    expect(s.sessions.slice(1)).toEqual([
      { sessionId: 'manual', provider: 'manual-provider', model: 'deepseek-flash' },
      { sessionId: 'official-other', provider: 'deepseek-official', model: 'other-user-choice' },
    ])
  } finally { await f.close() }
})


it.each(['save', 'partial'] as const)('真实pending：%s失败恢复确切已选会话，再改其它官方模型不漏接', async failure => {
  const f = await fixture()
  const s = sessionFixture(f, true)
  const fs = await import('node:fs/promises')
  const originalWriteFile = fs.writeFile
  let spy: ReturnType<typeof vi.spyOn> | undefined
  const official = (model: string) => ({ mode: 'own' as const, own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })
  try {
    expect((await s.service.update(official('deepseek-flash'))).ok).toBe(true)
    s.select('official-other', 'deepseek-official', 'deepseek-flash')
    const before = await readFile(f.modelFile, 'utf8')
    if (failure === 'save') spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (file === f.modelFile) throw new Error('save rejected')
      return originalWriteFile(file, data, options)
    })
    else s.rejectAfter(2)
    expect((await s.service.update(official(pro))).ok).toBe(false)
    expect(await readFile(f.modelFile, 'utf8')).toBe(before)
    expect(f.configs['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(s.sessions[0]?.model).toBe('deepseek-flash')
    expect(s.sessions[2]?.model).toBe('deepseek-flash')
    expect(s.feed.selectionOf('controlled')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(await s.opener.say!('controlled', 'blocked')).toBe(false)
    expect(s.prompts).toEqual([])
    spy?.mockRestore()
    expect((await s.service.update(official('qa-c'))).ok).toBe(true)
    expect(s.sessions[0]?.model).toBe('qa-c')
    expect(s.sessions[2]?.model).toBe('qa-c')
    expect(s.sessions[1]?.provider).toBe('manual-provider')
  } finally { spy?.mockRestore(); await f.close() }
})


it('pending回滚自身失败明确报错并拒发，后续设置先恢复旧选择再切新模型', async () => {
  const f = await fixture()
  const s = sessionFixture(f, true)
  const fs = await import('node:fs/promises')
  const originalWriteFile = fs.writeFile
  let spy: ReturnType<typeof vi.spyOn> | undefined
  const official = (model: string) => ({ mode: 'own' as const, own_base_url: OWN_DEFAULT_BASE_URL, own_model: model })
  try {
    expect((await s.service.update(official('deepseek-flash'))).ok).toBe(true)
    spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (file === f.modelFile) throw new Error('save rejected')
      return originalWriteFile(file, data, options)
    })
    s.rejectAfter(2) // B 选择成功，恢复 A 的那次选择失败。
    const failed = await s.service.update(official(pro))
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('恢复也未完成')
    expect(await s.opener.say!('controlled', 'blocked')).toBe(false)
    expect(s.prompts).toEqual([])
    expect(s.sessions[0]?.model).toBe(pro)
    spy.mockRestore()
    expect((await s.service.update(official('qa-c'))).ok).toBe(true)
    expect(s.sessions[0]?.model).toBe('qa-c')
    expect(await s.opener.say!('controlled', 'recovered')).toBe(true)
    expect(s.prompts.at(-1)?.model).toBe('qa-c')
  } finally { spy?.mockRestore(); await f.close() }
})
