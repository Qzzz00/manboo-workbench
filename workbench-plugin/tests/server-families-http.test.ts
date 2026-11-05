// @vitest-environment node
/**
 * ★ **家名候选池一处下发**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦ 第一条)。
 *
 * 从前「他嘴里那一家」有三个池:插件的 `spokenFamiliesNow()`、电话工人 `agentName.ts` 的
 * `FALLBACK_FAMILIES`、手机那份只有显示名的表。09-30 那道对照测试只钉住两份**别名**逐字相同
 * (`channel-worker/tests/agent-name-sync.test.ts`),候选池仍是两样 —— 运行时新接上的一家
 * (Grok Bot / Antigravity)电脑上认得出、电话里一次都认不出。
 *
 * 这一条钉主人那一侧的下发口 `GET /families`:
 * ① 探不到装机那一格时退回知识表(D13:查不到不等于没有),别名跟着下发;
 * ② 本机真探到了就只报那几家(没装的家不下发 —— 认出来只会得到一句「它没有在跑的对话」);
 * ③ ★ **登记表里运行时发现的那一家也下发**(就是旧的两个池漂掉的那一类);
 * ④ 只有候选池那三格,不夹带装机 / 额度 / 能不能派活(各有各的口)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FAMILY_ALIASES } from '../src/server/spokenFamily.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

interface FamilyRow { id: string, title: string, aliases?: readonly string[] }

async function families(url: string): Promise<readonly FamilyRow[]> {
  const res = await fetch(`${url}/families`)
  expect(res.status).toBe(200)
  const body = await res.json() as { families?: readonly FamilyRow[] }
  return body.families ?? []
}

/** 本机探测那一格:`undefined` = 探不到(退回知识表),数组 = 真探到了这几家。 */
async function serve(opts: { installed?: readonly { id: string, name: string }[], withRegistry?: boolean } = {}) {
  const service = createWorkbenchService({})
  const shell = fakeShell([{
    bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', running: true,
    probe: chatProbe(), read: () => chatRead({ answer: '好的。' }),
  }])
  const model = fakeModel({ 'Foo AI': 'ai_agent' })
  const agents = opts.withRegistry === true
    ? createAgentDiscovery({
        store: createMemoryRegistryStore(),
        helper: shell.helper,
        judge: model.judge,
        remainingCny: async () => 4,
        sessions: () => service.getState().sessions,
        setInterval: () => 1,
        clearInterval: () => {},
      })
    : undefined
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(agents === undefined ? {} : { agents }),
    ...(opts.installed === undefined
      ? {}
      : {
          installedAgents: {
            pump: () => {},
            view: () => ({ agents: opts.installed!.map(one => ({ ...one, bundle_id: `x.${one.id}`, installed: true })), line: '' }),
            installedIds: () => opts.installed!.map(one => one.id),
          } as never,
        }),
  })
  started.push(server)
  return { url: server.url, agents }
}

describe('GET /families —— 家名候选池只有这一处下发', () => {
  it('★ 探不到装机那一格:退回知识表那几家,别名跟着下发(D13:查不到不等于没有)', async () => {
    const { url } = await serve()
    const rows = await families(url)
    expect(rows.map(one => one.id)).toContain('codex')
    expect(rows.map(one => one.id)).toContain('doubao')
    // 事务官自己不是一家(他不会在电话里点名「事务官」去捎话)。
    expect(rows.map(one => one.id)).not.toContain('dsh')
    // 别名由主人那张表下发 —— 工人不必自己记一份(ChatGPT / GPT 归 Codex 就是 2851e0b0 漂掉的那一格)。
    expect(rows.find(one => one.id === 'codex')?.aliases).toEqual(FAMILY_ALIASES.codex)
    expect(rows.find(one => one.id === 'claude')?.aliases).toEqual(FAMILY_ALIASES.claude)
  })

  it('★ 本机真探到了:只下发探到的那几家(没装的不认)', async () => {
    const { url } = await serve({ installed: [{ id: 'claude', name: 'Claude' }, { id: 'manus', name: 'Manus' }] })
    const rows = await families(url)
    expect(rows.map(one => one.id)).toEqual(['claude', 'manus'])
    expect(rows.find(one => one.id === 'manus')?.aliases).toEqual(FAMILY_ALIASES.manus)
  })

  it('★ 登记表里运行时发现的那一家也下发(旧的两个池漂掉的正是这一类)', async () => {
    const { url, agents } = await serve({ installed: [{ id: 'claude', name: 'Claude' }], withRegistry: true })
    await agents?.tick()
    const rows = await families(url)
    expect(rows.map(one => one.title)).toContain('Foo AI')
  })

  it('★ 只有候选池那三格 —— 装机 / 额度 / 能不能派活各有各的口,不在这里重复一份', async () => {
    const { url } = await serve({ installed: [{ id: 'claude', name: 'Claude' }] })
    const rows = await families(url)
    for (const row of rows) {
      expect(Object.keys(row).sort().filter(key => key !== 'aliases')).toEqual(['id', 'title'])
    }
  })
})
