/**
 * 重启之后把引导会话先热起来(2026-09-24,维护者真机:DSH 为认新凭证重启一次,重启完他在电脑引导对话里
 * 说了一句,页面停在「在想…」很久,以为卡死 —— 其实是重启后第一轮的冷启动全压在他那句话上)。
 *
 * 钉三件事:
 *   ① 记号:只认 5 分钟内的、只认一次(普通开机不平白开会话);
 *   ② 新进程起来:有记号就自己把引导会话开出来(第一轮冷启动在他开口之前就过去了);
 *   ③ 页面随后来开会话:把热好的那条交出去,**不再往里说一遍**(不然她把「接着上次」念两遍);
 *   ④ (2026-09-24,卡 fix/firstrun-session-after-answers)热起来之后阶段机变了:那条的第一条消息按旧阶段写的,
 *      **不交**,另开一条按现在写的 —— 端到端两条在 tests/server-onboarding-session-after-answers.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingWarm, progressMark, WARM_CLAIM_MS, WARM_MARK_FRESH_MS } from '../src/server/onboardingWarm.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-onb-warm-'))
  dirs.push(root)
  return join(root, 'workbench', 'onboarding-warm.json')
}

describe('记号(onboardingWarm)', () => {
  it('记一笔 → 新进程取到一次;再取就没了', async () => {
    const file = tempFile()
    const warm = createOnboardingWarm({ file })
    await warm.mark()
    expect(JSON.parse(await readFile(file, 'utf8')).at).toBeTypeOf('string')
    expect(await warm.take()).toBe(true)
    expect(await warm.take()).toBe(false)
  })

  it('5 分钟前的记号不算(上一次没走完留下的,不该让普通开机平白开一条会话),照样删掉', async () => {
    const file = tempFile()
    let clock = 1_000_000_000_000
    const warm = createOnboardingWarm({ file, now: () => clock })
    await warm.mark()
    clock += WARM_MARK_FRESH_MS + 1
    expect(await warm.take()).toBe(false)
    expect(await readFile(file, 'utf8').catch(() => 'gone')).toBe('gone')
  })

  it('交出去:只交一次、只交当前那条、只交 2 分钟内热起来的', () => {
    let clock = 0
    const warm = createOnboardingWarm({ file: tempFile(), now: () => clock })
    warm.noteWarmed('s1')
    expect(warm.claim('s2')).toBeUndefined()
    warm.noteWarmed('s1')
    expect(warm.claim('s1')).toEqual({ kind: 'warm', session_id: 's1' })
    expect(warm.claim('s1')).toBeUndefined()
    warm.noteWarmed('s1')
    clock += WARM_CLAIM_MS + 1
    expect(warm.claim('s1')).toBeUndefined()
  })

  it('★热起来之后阶段机变了(阶段或已答项对不上):回 stale,不交;对得上照旧交;没记样子(老调用方)照旧交', () => {
    const warm = createOnboardingWarm({ file: tempFile() })
    const atBranch = progressMark({ stage: 'branch', answered: { opening: ['nickname'] } })
    const atTemplate = progressMark({ stage: 'template', answered: { opening: ['nickname'], branch: ['mode'] } })
    warm.noteWarmed('s1', atBranch)
    expect(warm.claim('s1', atTemplate)).toEqual({ kind: 'stale', session_id: 's1' })
    expect(warm.claim('s1', atTemplate)).toBeUndefined()
    warm.noteWarmed('s1', atTemplate)
    expect(warm.claim('s1', atTemplate)).toEqual({ kind: 'warm', session_id: 's1' })
    warm.noteWarmed('s1')
    expect(warm.claim('s1', atTemplate)).toEqual({ kind: 'warm', session_id: 's1' })
  })

  it('progressMark:只看阶段与答过哪几项(顺序无关、空的不算),不看值', () => {
    expect(progressMark({ stage: 'projects', answered: { projects: ['read_scan_roots', 'project'], opening: ['nickname'], habits: [] } }))
      .toBe(progressMark({ stage: 'projects', answered: { opening: ['nickname'], projects: ['project', 'read_scan_roots'] } }))
    expect(progressMark({ stage: 'projects', answered: { projects: ['project'] } }))
      .not.toBe(progressMark({ stage: 'projects', answered: { projects: ['project', 'read_scan_roots'] } }))
    expect(progressMark({ stage: 'branch', answered: {} })).not.toBe(progressMark({ stage: 'template', answered: {} }))
  })
})

function fakeOnboarding(log: string[]): OnboardingService {
  let sessionId: string | undefined
  return {
    view: () => ({ stage: 'template', done: false, label: '①′ 布局', step: 2, steps: 8 }),
    detail: () => ({ stage: 'template', done: false, plan: [], answered: {}, next: { label: '①′', seed: '先挑一套布局', goals: [], keys: [] }, ...(sessionId === undefined ? {} : { session_id: sessionId }) }),
    openSession: async () => {
      log.push('open')
      sessionId = 's-warm'
      return { ok: true, stage: 'template', session_id: sessionId, first_message: '接着上次', seed: '先挑一套布局', resumed: true }
    },
  } as unknown as OnboardingService
}

async function serve(warmFile: string, log: string[]) {
  const warm = createOnboardingWarm({ file: warmFile, delayMs: 0 })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => 1_758_100_000 }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    onboarding: fakeOnboarding(log),
    onboardingWarm: warm,
  })
  started.push(server)
  return { server, warm }
}

async function until(check: () => boolean): Promise<void> {
  for (let k = 0; k < 100 && !check(); k++) await new Promise(resolve => setTimeout(resolve, 10))
}

describe('新进程起来之后(接在 startWorkbenchServer 上)', () => {
  it('有新鲜记号:自己把引导会话开出来;页面随后来开,把那条交出去、不再往里说一遍', async () => {
    const file = tempFile()
    await createOnboardingWarm({ file }).mark()
    const log: string[] = []
    const { server } = await serve(file, log)
    await until(() => log.length > 0)
    expect(log).toEqual(['open'])

    const res = await fetch(`${server.url}/onboarding/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.session_id).toBe('s-warm')
    expect(body.warmed).toBe(true)
    // 没有第二次 openSession:她不会把「接着上次」念两遍。
    expect(log).toEqual(['open'])

    // 交过一次之后恢复原样:再来就照常开(往会话里续)。
    await fetch(`${server.url}/onboarding/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(log).toEqual(['open', 'open'])
  })

  it('没有记号(普通开机):什么都不开', async () => {
    const log: string[] = []
    await serve(tempFile(), log)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(log).toEqual([])
  })
})
