// @vitest-environment node
/**
 * 统一输入框的服务端纯函数与文件服务(2026-09-24,docs/设计-统一输入框-2026-09-24.md)。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalViews, attachmentIds, composerAgents, composerModels, composerOptions, composerTail, createApprovalBroker,
  createComposerService, defaultComposerInboxDir, modeOfTask, modelTakesImages, parseComposerChoice, refInputs, refLines,
  safeFileName, submitForMode, uniqueFileName,
} from '../src/server/composer.ts'
import type { ComposerAgentSignals, ModelCatalogLike } from '../src/server/composer.ts'
import type { AgentCard } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-composer-'))
  dirs.push(dir)
  return dir
}

const NOW = new Date('2026-09-24T10:00:00.000Z')

/** 中转上 OpenAI 与豆包都配了(`/health` 的 providers;卡 GH 2026-09-26)。 */
const BOTH_CONFIGURED = { deepseek: true, openai: true, doubao: true }

function signals(partial: Partial<ComposerAgentSignals> & { state?: Partial<ComposerAgentSignals['state']> } = {}): ComposerAgentSignals {
  return {
    clis: new Set(),
    windowReady: true,
    apiReady: false,
    now: NOW,
    ...partial,
    state: { ...partial.state },
  }
}

describe('composerAgents:@ 候选实时算', () => {
  it('什么都没有 → 只有事务官自己', () => {
    expect(composerAgents(signals()).map(one => one.family)).toEqual(['dsh'])
  })

  it('窗口槽里的那家出现、能用窗口那只手;没进槽也没用过的那家不列', () => {
    const out = composerAgents(signals({ state: { apps: [{ key: 'claude', label: 'Claude' }], clients: { claude: { installed: true, connected: true }, codex: { installed: true, connected: false }, kimi: { installed: false, connected: false }, wechat: { installed: false, connected: false }, wecom: { installed: false, connected: false } } } }))
    expect(out.map(one => one.family)).toEqual(['dsh', 'claude'])
    expect(out[1]).toMatchObject({ in_slot: true, ready: true, hands: [{ hand: 'window', ready: true }] })
  })

  it('近 30 天用过的出现(会话里看到的);更早的不算', () => {
    const out = composerAgents(signals({ state: { sessions: [
      { agent: 'codex', updated_at: '2026-09-20T00:00:00.000Z' },
      { agent: 'kimi', updated_at: '2026-07-01T00:00:00.000Z' },
    ] as never } }))
    expect(out.map(one => one.family)).toEqual(['dsh', 'codex'])
    expect(out[1]?.last_used_at).toBe('2026-09-20T00:00:00.000Z')
  })

  it('本机有命令行的出现;窗口没装就灰着说原因', () => {
    const out = composerAgents(signals({ clis: new Set(['codex']) }))
    const codex = out.find(one => one.family === 'codex')
    expect(codex?.ready).toBe(true)
    expect(codex?.hands).toEqual([
      { hand: 'window', ready: false, why: '这台电脑上没装它' },
      { hand: 'cli', ready: true },
    ])
  })

  it('★Muse / Manus / 豆包(没有会话流的那几家)装了就列出来,窗口那只手能用(2026-09-24,卡 F)', () => {
    const installed = new Set(['muse', 'manus', 'doubao'])
    const out = composerAgents(signals({ appInstalled: family => installed.has(family) }))
    expect(out.map(one => one.family)).toEqual(['dsh', 'doubao', 'muse', 'manus'])
    expect(out.find(one => one.family === 'muse')).toMatchObject({ ready: true, hands: [{ hand: 'window', ready: true }] })
    expect(out.find(one => one.family === 'doubao')?.hands[0]).toEqual({ hand: 'window', ready: true })
    // 没装的不列;窗口编排没接上时也不列(列出来也是一颗点了没反应的钮)。
    expect(composerAgents(signals({ appInstalled: () => false })).map(one => one.family)).toEqual(['dsh'])
    expect(composerAgents(signals({ windowReady: false, appInstalled: () => true })).map(one => one.family)).toEqual(['dsh'])
  })

  it('中转接上了、而且那两家上游都配了 → GPT 与豆包走接口那只手出现', () => {
    // 卡 GH(2026-09-26):「中转接上了」不够 —— 还要中转上真配了这一家的上游(`/health` 的 providers)。
    const out = composerAgents(signals({ apiReady: true, relayProviders: BOTH_CONFIGURED }))
    // 卡 Z(2026-09-25):没在槽里、没用过的那几家按什么顺序排 = 登记表 / 专门接法那一份的顺序
    // (原来是写死的 AGENT_DISPATCH_FAMILIES,GPT 在豆包前面)。排序规则本身没变:在槽里 > 用过 > 其余。
    expect(out.map(one => one.family)).toEqual(['dsh', 'doubao', 'gpt'])
    expect(out.find(one => one.family === 'gpt')?.hands).toEqual([{ hand: 'api', ready: true }])
  })

  /**
   * ★ 卡 GH(2026-09-26):中转上没配 OpenAI 时 **GPT 压根不列**(只有接口那一只手,列出来也是点了必失败的);
   * 豆包**照常在**,只是接口那一只标成「中转没配这家」—— 它还有窗口那只手。
   */
  it('★中转没配那一家 → 只有接口那只手的 GPT 不列;豆包照常在、接口那只标不可用', () => {
    const none = { deepseek: true, openai: false, doubao: false }
    expect(composerAgents(signals({ apiReady: true, relayProviders: none })).map(one => one.family)).toEqual(['dsh'])
    // `/health` 一次都没问到过(缺席)= 同样当没配。
    expect(composerAgents(signals({ apiReady: true })).map(one => one.family)).toEqual(['dsh'])
    // 豆包装着、窗口那只手接得上:整家在,接口那一只如实写「中转没配这家」。
    const out = composerAgents(signals({ apiReady: true, relayProviders: none, appInstalled: family => family === 'doubao' }))
    expect(out.map(one => one.family)).toEqual(['dsh', 'doubao'])
    expect(out.find(one => one.family === 'doubao')?.hands).toEqual([
      { hand: 'window', ready: true },
      { hand: 'api', ready: false, why: '中转没配这家' },
    ])
  })

  it('排序:窗口槽里 > 最近用过 > 其余', () => {
    const out = composerAgents(signals({
      apiReady: true,
      relayProviders: BOTH_CONFIGURED,
      state: {
        apps: [{ key: 'kimi', label: 'Kimi' }],
        sessions: [{ agent: 'codex', updated_at: '2026-09-23T00:00:00.000Z' }] as never,
      },
    }))
    expect(out.map(one => one.family)).toEqual(['dsh', 'kimi', 'codex', 'doubao', 'gpt'])
  })

  it('壳没接上 → 窗口那只手不能用,如实写', () => {
    const out = composerAgents(signals({ windowReady: false, state: { apps: [{ key: 'claude', label: 'Claude' }] } }))
    expect(out[1]).toMatchObject({ family: 'claude', ready: false, hands: [{ hand: 'window', ready: false, why: '窗口编排没接上' }] })
  })

  it('协作区自定义名片(agent_cards)带出真实身份与名称,后端分派未接前标未就绪(ready: false)', () => {
    const cardKimi: AgentCard = {
      id: 'agent:local:kimi-card-1',
      name: '小K',
      owner: 'me',
      hand: 'cli',
      runtime: { family: 'kimi' },
      skills: ['代码重构', 'TDD测试'],
      model: { name: 'kimi-k1.5' },
      shared: { to: 'none' },
      created_at: '2026-10-23T10:00:00.000Z',
      updated_at: '2026-10-23T10:00:00.000Z',
    }
    const out = composerAgents(signals({
      state: {
        tasks: {
          tasks: [], sprints: [], modules: [], project_meta: [],
          agent_cards: [cardKimi],
        },
      },
    }))
    const kimiCandidate = out.find(one => one.title === '小K')
    expect(kimiCandidate).toBeDefined()
    expect(kimiCandidate).toMatchObject({
      title: '小K',
      family: 'kimi',
      ready: false,
      hands: [{ hand: 'cli', ready: false, why: '名片分派待公共接线' }],
    })
  })
})

const CATALOG: ModelCatalogLike = {
  default: { provider: 'workbench-relay', model: 'deepseek-v4-flash' },
  routableProviders: ['workbench-relay'],
  groups: [
    { id: 'workbench-relay', name: '工作台', models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
  ],
  failures: [],
}

describe('模型', () => {
  it('只列能用的路由;中转那组按表给短名与看图能力', () => {
    expect(composerModels(CATALOG)).toEqual([
      { provider: 'workbench-relay', id: 'deepseek-v4-flash', title: 'V4 Flash', images: true },
      { provider: 'workbench-relay', id: 'deepseek-v4-pro', title: 'V4 Pro', images: false },
    ])
  })

  it('modelTakesImages', () => {
    const models = composerModels(CATALOG)
    expect(modelTakesImages(models, { provider: 'workbench-relay', id: 'deepseek-v4-flash' })).toBe(true)
    expect(modelTakesImages(models, { provider: 'workbench-relay', id: 'deepseek-v4-pro' })).toBe(false)
    expect(modelTakesImages(models, undefined)).toBe(false)
  })

  it('composerOptions:选过的模型在表里就用它,不在就用 DSH 的默认;拿不到表时说一句', () => {
    const base = { agents: [], tasks: [], projects: [] }
    expect(composerOptions({ ...base, choice: { mode: 'auto', model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } }, catalog: CATALOG }).model)
      .toEqual({ provider: 'workbench-relay', id: 'deepseek-v4-pro' })
    expect(composerOptions({ ...base, choice: { mode: 'ask', model: { provider: 'x', id: 'y' } }, catalog: CATALOG }).model)
      .toEqual({ provider: 'workbench-relay', id: 'deepseek-v4-flash' })
    const none = composerOptions({ ...base, choice: { mode: 'ask' } })
    expect(none.model).toBeUndefined()
    expect(none.models_note).toContain('DSH')
    expect(none.modes.map(one => one.title)).toEqual(['只出方案', '先问我', '自动办'])
  })

  it('composerOptions:最近的事项(没办完的,新的在前)与项目', () => {
    const out = composerOptions({
      agents: [],
      choice: { mode: 'ask' },
      tasks: [
        { id: 't-1', title: '旧的', status: 'doing', updated_at: '2026-09-20T00:00:00Z' },
        { id: 't-2', title: '新的', status: 'todo', updated_at: '2026-09-23T00:00:00Z' },
        { id: 't-3', title: '办完的', status: 'done', updated_at: '2026-09-24T00:00:00Z' },
      ],
      projects: [{ id: 'p-1', name: '工作台' }, { id: 'p-2', name: '睡着的', idle: true }],
    })
    expect(out.recent.map(one => one.id)).toEqual(['t-2', 't-1', 'p-1'])
  })
})

describe('选择与模式', () => {
  it('parseComposerChoice:坏值回默认「先问我」', () => {
    expect(parseComposerChoice(undefined)).toEqual({ mode: 'ask' })
    expect(parseComposerChoice({ mode: 'full', model: { provider: '', id: 'x' } })).toEqual({ mode: 'ask' })
    expect(parseComposerChoice({ mode: 'plan', model: { provider: 'p', id: 'm' } })).toEqual({ mode: 'plan', model: { provider: 'p', id: 'm' } })
  })

  it('没有「全权」这一档', () => {
    expect(parseComposerChoice({ mode: 'danger-full-access' }).mode).toBe('ask')
  })

  it('modeOfTask:老卡当「先问我」;只有「自动办」替他按回车', () => {
    expect(modeOfTask(undefined)).toBe('ask')
    expect(modeOfTask({ mode: 'plan' })).toBe('plan')
    expect(submitForMode('auto')).toBe(true)
    expect(submitForMode('ask')).toBe(false)
    expect(submitForMode('plan')).toBe(false)
  })
})

describe('附件与引用', () => {
  it('safeFileName:只留一段、不许隐藏文件', () => {
    expect(safeFileName('../../.dsh/settings.yaml')).toBe('settings.yaml')
    expect(safeFileName('.bashrc')).toBe('bashrc')
    expect(safeFileName('')).toBe('文件')
  })

  it('uniqueFileName:不覆盖', () => {
    const taken = new Set(['图.png', '图-2.png'])
    expect(uniqueFileName('图.png', name => taken.has(name))).toBe('图-3.png')
  })

  it('attachmentIds:字符串与 {id} 都认,去重,清洗', () => {
    expect(attachmentIds(['a.png', { id: 'a.png' }, { id: '../b.pdf' }, 3, ''])).toEqual(['a.png', 'b.pdf'])
    expect(attachmentIds('x')).toEqual([])
  })

  it('refInputs + refLines:原样拼,查不到如实说', () => {
    const refs = refInputs([{ kind: 'item', id: 't-1' }, { kind: 'project', id: 'p-9' }, { kind: 'x', id: '1' }])
    expect(refs).toEqual([{ kind: 'item', id: 't-1' }, { kind: 'project', id: 'p-9' }])
    const lines = refLines(refs, { tasks: [{ id: 't-1', title: '导出 PDF', status: 'doing' }], projects: [] })
    expect(lines[0]).toBe('- 事项「导出 PDF」(在办,id t-1)')
    expect(lines[1]).toContain('没找到')
  })

  it('composerTail:模式那句 + 附件路径 + 引用', () => {
    const tail = composerTail({
      mode: 'plan',
      attachments: [{ name: 'a.png', path: '/x/a.png', bytes: 3, imageType: 'image/png' }, { name: 'b.pdf', path: '/x/b.pdf', bytes: 3 }],
      imagesInline: true,
      refs: ['- 事项「导出 PDF」'],
    })
    expect(tail).toContain('只出方案')
    expect(tail).toContain('- /x/a.png(图片,已经放在这条消息里)')
    expect(tail).toContain('- /x/b.pdf')
    expect(tail).toContain('他引用了:\n- 事项「导出 PDF」')
  })

  it('defaultComposerInboxDir:与手机发文件同一处,环境变量优先', () => {
    expect(defaultComposerInboxDir({}, '/Users/x')).toBe('/Users/x/Documents/事务官/收件')
    expect(defaultComposerInboxDir({ WORKBENCH_CHANNEL_INBOX_DIR: '/tmp/in' }, '/Users/x')).toBe('/tmp/in')
  })
})

describe('createComposerService', () => {
  it('上传 → 落进收件文件夹、重名不覆盖;resolve 找得到;图片读成 base64', async () => {
    const dir = tempDir()
    const service = createComposerService({ choiceFile: join(dir, 'composer.json'), inboxDir: join(dir, 'in') })
    const one = await service.upload({ name: '截图.png', data: Buffer.from('png!') })
    const two = await service.upload({ name: '截图.png', data: Buffer.from('png2') })
    expect(one).toMatchObject({ ok: true, view: { id: '截图.png', image: true, type: 'image/png', bytes: 4 } })
    expect(two).toMatchObject({ ok: true, view: { id: '截图-2.png' } })
    const doc = await service.upload({ name: '需求.pdf', type: 'application/pdf', data: Buffer.from('%PDF') })
    expect(doc).toMatchObject({ ok: true, view: { image: false, type: 'application/pdf' } })
    const resolved = await service.resolve(['截图.png', '需求.pdf', '没有.txt'])
    expect(resolved.found.map(one => one.name)).toEqual(['截图.png', '需求.pdf'])
    expect(resolved.missing).toEqual(['没有.txt'])
    expect(await service.readImage(resolved.found[0]!)).toBe(Buffer.from('png!').toString('base64'))
    expect(await service.readImage(resolved.found[1]!)).toBeUndefined()
  })

  it('空文件不收', async () => {
    const dir = tempDir()
    const service = createComposerService({ choiceFile: join(dir, 'c.json'), inboxDir: dir })
    expect(await service.upload({ name: 'x', data: Buffer.alloc(0) })).toEqual({ ok: false, error: '这个文件是空的' })
  })

  it('resolve 等一等手机字节流晚到的那一份', async () => {
    const dir = tempDir()
    const service = createComposerService({ choiceFile: join(dir, 'c.json'), inboxDir: dir })
    setTimeout(() => writeFileSync(join(dir, 'late.png'), 'x'), 300)
    const resolved = await service.resolve(['late.png'], 3000)
    expect(resolved.found.map(one => one.name)).toEqual(['late.png'])
  })

  it('选择粘性:存下再读回,缺的字段保留原值', async () => {
    const dir = tempDir()
    const file = join(dir, 'composer.json')
    const service = createComposerService({ choiceFile: file, inboxDir: dir })
    expect(await service.choice()).toEqual({ mode: 'ask' })
    await service.saveChoice({ model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
    await service.saveChoice({ mode: 'auto' })
    expect(await service.choice()).toEqual({ mode: 'auto', model: { provider: 'workbench-relay', id: 'deepseek-v4-pro' } })
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('auto')
  })
})

describe('审批经纪人', () => {
  it('挂上 → 列得出 → 答了 → 回 allowed-once,表空了', async () => {
    const broker = createApprovalBroker(() => NOW)
    let changes = 0
    broker.onChange(() => { changes += 1 })
    const { id, answer } = broker.ask({ sessionId: 's-1', tool: 'bash', reason: '要写 /etc/hosts' })
    expect(broker.list()).toEqual([{ id, session_id: 's-1', tool: 'bash', reason: '要写 /etc/hosts', at: NOW.toISOString() }])
    expect(broker.answer(id, true)).toBe(true)
    expect(await answer).toBe('allowed-once')
    expect(broker.list()).toEqual([])
    expect(broker.answer(id, false)).toBe(false)
    expect(changes).toBe(2)
  })

  it('拒绝 → rejected;取消 → cancelled', async () => {
    const broker = createApprovalBroker()
    const a = broker.ask({ sessionId: 's', tool: 't' })
    broker.answer(a.id, false)
    expect(await a.answer).toBe('rejected')
    const controller = new AbortController()
    const b = broker.ask({ sessionId: 's', tool: 't', signal: controller.signal })
    controller.abort()
    expect(await b.answer).toBe('cancelled')
    expect(broker.list()).toEqual([])
  })

  it('approvalViews:按会话配上卡', () => {
    const views = approvalViews(
      [{ id: 'a', session_id: 's-1', tool: 'bash', at: 'x' }, { id: 'b', session_id: 's-2', tool: 'fs', at: 'y' }],
      [{ id: 't-1', title: '导出 PDF', conversation: { agent: 'dsh', session_id: 's-1' } }],
    )
    expect(views[0]).toMatchObject({ task_id: 't-1', task_title: '导出 PDF' })
    expect(views[1]?.task_id).toBeUndefined()
  })
})
