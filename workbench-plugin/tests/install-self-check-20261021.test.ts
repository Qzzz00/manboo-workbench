// @vitest-environment node
/**
 * 安装器末尾自检三件(2026-10-21,卡「引导三件事」;设计稿第二节第 2 条)。
 *
 * 装完不只说「装上了」:早报、交代、电话三样各写一行「成 / 没成 + 缺哪道门」,不说「都好了」。
 *   · 服务起来了 → 打 8791 的 `/first-use/selfcheck` 真跑一遍,等三行出来(交代那件没回就写「在路上」);
 *   · 没起服务(隔离环境 `--no-launch`、或等不到 8791)→ 只看本机的几个文件,写得出的门照写,
 *     写不出的如实说「这一遍没起服务,没真跑」—— 新机器演练(`pnpm rehearse`)接的是这一版,不依赖跑着的服务。
 */
import { describe, expect, it } from 'vitest'
import { ALL_GOOD_WORDS } from '../src/mainPaths.ts'
import { checkEventsOf, liveSelfCheck, offlineSelfCheck, readOfflineFacts, rehearseRowsOf } from '../src/server/setup/installSelfCheck.ts'

describe('没起服务:只看本机文件', () => {
  it('模型没领、两家都没装、手机没配:三行各写缺哪道门', () => {
    const rows = offlineSelfCheck({ model: false, coders: [{ family: 'claude', title: 'Claude', found: false }, { family: 'codex', title: 'Codex', found: false }], phonePaired: false, workerInstalled: true, why: '这一遍没起服务(--no-launch)' })
    expect(rows.map(one => [one.path, one.state, one.door?.door])).toEqual([
      ['morning', 'missing', 'model'],
      ['delegate', 'missing', 'ai_missing'],
      ['call', 'missing', 'phone'],
    ])
  })

  it('门都在的那几件也不说成:如实说没起服务、没真跑', () => {
    const rows = offlineSelfCheck({ model: true, coders: [{ family: 'codex', title: 'Codex', found: true }], phonePaired: true, workerInstalled: true, why: '这一遍没起服务(--no-launch)' })
    expect(rows.every(one => one.state === 'missing' && one.door?.door === 'service')).toBe(true)
    expect(rows[0]?.door?.text).toContain('没真跑')
  })

  it('读本机文件:model.json 有令牌 = 模型接上了;devices.json 里有手机 = 配过;座机不算', async () => {
    const files: Record<string, string> = {
      '/h/.dsh/workbench/model.json': JSON.stringify({ mode: 'relay', relay_url: 'https://relay.test', relay_token: 'secret-never-shown' }),
      '/h/.dsh/workbench/devices.json': JSON.stringify({ devices: [{ id: 'd1', name: '座机', platform: 'handset' }] }),
    }
    const facts = await readOfflineFacts({
      dshHome: '/h/.dsh',
      readFile: async (file) => { const text = files[file]; if (text === undefined) throw new Error('ENOENT'); return text },
      exists: async file => file === '/h/.local/bin/claude' || file === '/h/.dsh/channel-worker',
      home: '/h',
    })
    expect(facts.model).toBe(true)
    expect(facts.phonePaired).toBe(false)
    expect(facts.coders.find(one => one.family === 'claude')?.found).toBe(true)
    expect(facts.coders.find(one => one.family === 'codex')?.found).toBe(false)
    expect(JSON.stringify(facts)).not.toContain('secret-never-shown')
  })
})

describe('服务起来了:打 8791 真跑一遍', () => {
  it('起一遍、等到三行出来', async () => {
    let polls = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true, running: true }), { status: 202 })
      polls++
      const ended = polls >= 2
      return new Response(JSON.stringify({
        started_at: 'x',
        ...(ended ? { ended_at: 'y' } : {}),
        rows: [{ path: 'morning', state: 'ok' }, { path: 'delegate', state: ended ? 'pending' : 'running', note: '派给 Codex 了' }, { path: 'call', state: ended ? 'missing' : 'running', door: { door: 'phone', title: '手机没配对', text: 'x', fixes: [] } }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const rows = await liveSelfCheck({ baseUrl: 'http://127.0.0.1:8791', fetchImpl, pollMs: 0, timeoutMs: 5000 })
    expect(rows?.map(one => one.state)).toEqual(['ok', 'pending', 'missing'])
  })

  it('8791 打不通:回 undefined,调用方退回只看文件那一版', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await liveSelfCheck({ baseUrl: 'http://127.0.0.1:8791', fetchImpl, pollMs: 0, timeoutMs: 50 })).toBeUndefined()
  })
})

describe('发出去的样子', () => {
  const rows = offlineSelfCheck({ model: false, coders: [], phonePaired: false, workerInstalled: false, why: '这一遍没起服务' })

  it('安装器事件:一行一件 + 一句总结,总结不说「都好了」', () => {
    const events = checkEventsOf(rows)
    expect(events.filter(one => one.t === 'check')).toHaveLength(3)
    const summary = events.find(one => one.t === 'note')
    expect(summary).toBeDefined()
    for (const word of ALL_GOOD_WORDS) expect(JSON.stringify(events)).not.toContain(word)
    expect(events[0]).toMatchObject({ t: 'check', key: 'morning', title: '早报与播客', ok: false, gate: 'model' })
  })

  it('演练卡要的那一行形状:{ key, title, ok, gate?, detail }', () => {
    expect(rehearseRowsOf(rows)[0]).toEqual({ key: 'morning', title: '早报与播客', ok: false, gate: 'model', detail: expect.stringMatching(/^早报与播客:没成 —— 缺模型钥匙/) })
  })
})
