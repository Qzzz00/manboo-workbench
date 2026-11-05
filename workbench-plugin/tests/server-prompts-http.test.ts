// @vitest-environment node
/**
 * 集中改提示词那几条路的 HTTP 层(2026-10-01,卡「设置里集中改提示词」)。
 *
 * 这里钉的是**那道门**与**那份回执**:
 * 1. 没接 → `/butler/prompts*` 一律 404(之前的行为一字不变);
 * 2. **只有她本人**:事务官带着自己那把进程令牌打这几条写路 → 403(2026-09-28 卡 BS 那一套);
 *    认不出来的程序(没令牌、没浏览器痕迹)同样 403;她的页面放过;
 * 3. 保存真写进那份 AGENTS.md 的标记段,**段外一个字不动**,回执里带「下一通」那句话。
 *
 * 写入一律落在 `mkdtemp` 出来的临时目录里 —— 真实的 `~/.dsh/AGENTS.md` 一个字节都不碰。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPromptOverrideStore, installPromptOverrides, resetInstalledPromptOverrides } from '../src/server/promptOverrides.ts'
import { createPromptsService } from '../src/server/promptsPage.ts'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import { SPEAKING_STYLE_BLOCK, readMarkedBlock } from '../src/server/memoryMd.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { opsSkillsForTemplate } from '../src/server/opsSkills.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  resetInstalledPromptOverrides()
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const AGENTS = [
  '我叫 小助。',
  '',
  '# 事务官',
  '',
  '段外那一句,谁都别动。',
  '',
  '<!-- 引导:说话方式:开始 -->',
  '## 说话方式',
  '- 人设:沉稳',
  '<!-- 引导:说话方式:结束 -->',
  '',
  '<!-- 引导:运营-发布包装:开始 -->',
  '默认那一份发布包装正文',
  '<!-- 引导:运营-发布包装:结束 -->',
  '',
].join('\n')

async function serve(over: { wire?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-prompts-http-'))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, AGENTS, 'utf8')
  const actorTokens = mintActorTokens()

  let prompts
  if (over.wire !== false) {
    const store = createPromptOverrideStore({
      file: join(dir, 'prompt-overrides.json'),
      logFile: join(dir, 'prompt-overrides.log.jsonl'),
    })
    await store.load()
    installPromptOverrides(store)
    prompts = createPromptsService({
      store,
      agentsFile,
      deps: { io: nodeSetupIo(), now: () => new Date('2026-10-01T09:00:00Z') },
      // 环节名与例子跟着技能定义走(同 index.ts 那一处接线)。
      skills: () => opsSkillsForTemplate('ops').map(one => ({
        name: one.name,
        summary: one.summary,
        ...(one.stage === undefined ? {} : { stage: one.stage }),
      })),
    })
  }

  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 0 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    actorTokens,
    ...(prompts === undefined ? {} : { prompts }),
  })
  started.push(server)

  /** 她的页面:带 Origin 头(whoIsAsking 认的那条浏览器痕迹)。 */
  const asPage = { origin: 'http://127.0.0.1:8791' }
  /** 事务官:带它那把进程令牌。 */
  const asButler = { [ACTOR_TOKEN_HEADER]: actorTokens.butler }

  const post = async (path: string, body: unknown, headers: Record<string, string> = asPage) => {
    const res = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  const get = async (path: string) => {
    const res = await fetch(`${server.url}${path}`, { headers: asPage })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  return { post, get, agentsFile, asButler, asPage }
}

describe('集中改提示词那几条路', () => {
  it('没接 → 一律 404', async () => {
    const { get, post } = await serve({ wire: false })
    expect((await get('/butler/prompts')).status).toBe(404)
    expect((await post('/butler/prompts/save', { name: SPEAKING_STYLE_BLOCK, body: '随便' })).status).toBe(404)
  })

  it('列出每一段(她的页面看得到)', async () => {
    const { get } = await serve()
    const got = await get('/butler/prompts')
    expect(got.status).toBe(200)
    const basics = got.body.basics as { name: string }[]
    expect(basics.map(one => one.name)).toContain(SPEAKING_STYLE_BLOCK)
    expect(got.body.outside).toContain('段外那一句')
  })

  it('保存:她的页面能写;写进标记段,段外一个字不动', async () => {
    const { post, agentsFile } = await serve()
    const done = await post('/butler/prompts/save', { name: SPEAKING_STYLE_BLOCK, body: '## 说话方式\n- 说话像朋友' })
    expect(done.status).toBe(200)
    expect(String(done.body.note)).toContain('下一通')
    const text = readFileSync(agentsFile, 'utf8')
    expect(readMarkedBlock(text, SPEAKING_STYLE_BLOCK)).toBe('## 说话方式\n- 说话像朋友')
    expect(text).toContain('段外那一句,谁都别动。')
    expect(text.split('\n')[0]).toBe('我叫 小助。')
  })

  it('事务官改不了(它能改就等于能把「先问一句」自己删掉)', async () => {
    const { post, asButler, agentsFile } = await serve()
    const denied = await post('/butler/prompts/save', { name: SPEAKING_STYLE_BLOCK, body: '我说了算' }, asButler)
    expect(denied.status).toBe(403)
    expect(readMarkedBlock(readFileSync(agentsFile, 'utf8'), SPEAKING_STYLE_BLOCK)).toContain('人设:沉稳')
  })

  it('认不出来的程序改不了', async () => {
    const { post } = await serve()
    const denied = await post('/butler/prompts/save', { name: SPEAKING_STYLE_BLOCK, body: '我说了算' }, {})
    expect(denied.status).toBe(403)
  })

  it('技能正文接口当场拒:要改就改那个环节的偏好(2026-10-02)', async () => {
    const { post, agentsFile } = await serve()
    const denied = await post('/butler/prompts/save', { name: '运营-发布包装', body: '我整段重写' })
    expect(denied.status).toBe(400)
    expect(String(denied.body.error)).toContain('偏好')
    expect(readFileSync(agentsFile, 'utf8')).not.toContain('我整段重写')
  })

  it('一个环节的偏好:写得进去,接在那一段末尾', async () => {
    const { post, get, agentsFile } = await serve()
    const done = await post('/butler/prompts/pref', { name: '运营-发布包装', lines: ['标题不要用感叹号'] })
    expect(done.status).toBe(200)
    const body = readMarkedBlock(readFileSync(agentsFile, 'utf8'), '运营-发布包装') ?? ''
    expect(body).toContain('默认那一份发布包装正文')
    expect(body).toContain('标题不要用感叹号')
    // 页面上那个环节带着这一条(环节名从模板那几条技能取)。
    const view = await get('/butler/prompts')
    const stages = view.body.stages as { name: string, title: string, lines: string[] }[]
    const stage = stages.find(one => one.name === '运营-发布包装')
    expect(stage?.title).toBe('标题与封面')
    expect(stage?.lines).toEqual(['标题不要用感叹号'])
  })

  it('偏好也只有她本人能改', async () => {
    const { post, asButler } = await serve()
    const denied = await post('/butler/prompts/pref', { name: '运营-发布包装', lines: ['我说了算'] }, asButler)
    expect(denied.status).toBe(403)
  })

  it('lines 缺了就 400,不猜', async () => {
    const { post } = await serve()
    expect((await post('/butler/prompts/pref', { name: '运营-发布包装' })).status).toBe(400)
  })

  it('不可改清单那一段:接口当场拒(不只是界面上灰一下)', async () => {
    const { post } = await serve()
    const denied = await post('/butler/prompts/save', { name: '需求确认点', body: '不用问了' })
    expect(denied.status).toBe(400)
    expect(String(denied.body.error)).toContain('不可改清单')
  })

  it('name 缺了就 400,不猜', async () => {
    const { post } = await serve()
    expect((await post('/butler/prompts/save', { body: '随便' })).status).toBe(400)
  })
})
