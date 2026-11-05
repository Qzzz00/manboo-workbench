/**
 * ★ **认家名那一池从主人那里来**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦ 第一条)。
 *
 * 现场(审计第二表第 8 条):「名字 → 家」有三个候选池。工人这一份的候选缺省是写死的知识表,
 * 于是**运行时发现的那几家**(Grok Bot `com.anysphere.sand`、Antigravity `com.google.antigravity`)
 * 在电脑上认得出、在电话里一次都认不出 —— 而她在电话里点名派活走的正是工人这一份。
 *
 * 这一条钉工人那一侧:
 * ① 拉到了就用主人那一份(运行时发现的那一家跟着认得出);
 * ② 拉不到 / 回包坏了 → 退回自带那份,**并且说得出是哪一份**(不装作拉到了);
 * ③ 一行坏了不许清空整池(形状容错);
 * ④ 念那条会话的家名问同一池(从前是第四份写死的四家表);
 * ⑤ `GET /families` 这条路三种「没拉到」各说清是哪一种。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_FAMILIES,
  canonicalWho,
  familyPool,
  familyPoolSource,
  familyTitle,
  matchSpokenFamily,
  setFamilyPool,
} from '../src/agentName.ts'
import { agentSessionsOf, createWorkbenchClient, spokenAgentSessions } from '../src/workbench.ts'

// 模块级那一格是进程寿命的,每条用例跑完清回「没拉到」。
afterEach(() => setFamilyPool(undefined))

/** 主人那一侧真回过的形状(2026-10-03 `GET /families`:探到的那几家 + 登记表里运行时发现的两家)。 */
const DOWNSTREAM = [
  { id: 'claude', title: 'Claude', aliases: ['克劳德'] },
  { id: 'codex', title: 'Codex', aliases: ['ChatGPT', 'GPT', 'Chat GPT'] },
  { id: 'doubao', title: '豆包办公', aliases: ['豆包', '豆包工作', 'Doubao'] },
  { id: 'com.anysphere.sand', title: 'Grok Bot' },
  { id: 'com.google.antigravity', title: 'Antigravity' },
]

describe('★ 候选池:主人下发的那一份为准', () => {
  it('没拉到时是自带那份,说得出是兜底', () => {
    expect(familyPoolSource()).toBe('fallback')
    expect(familyPool()).toEqual(FALLBACK_FAMILIES)
  })

  it('★ 拉到了就整池换掉 —— 运行时发现的那一家电话里也认得出(旧的两个池漂掉的正是这一类)', () => {
    // 换之前:知识表里压根没有 Grok Bot,一家都不像。
    expect(matchSpokenFamily('让 Grok Bot 看一眼').kind).toBe('none')
    setFamilyPool(DOWNSTREAM)
    expect(familyPoolSource()).toBe('workbench')
    expect(matchSpokenFamily('让 Grok Bot 看一眼')).toMatchObject({ kind: 'one', id: 'com.anysphere.sand' })
    expect(matchSpokenFamily('让 Antigravity 跑一下')).toMatchObject({ kind: 'one', id: 'com.google.antigravity' })
  })

  it('★ 别名也跟着主人那一份下来(ChatGPT → Codex:2851e0b0 漂的那一格)', () => {
    setFamilyPool(DOWNSTREAM)
    // 这一池里没有「只走接口」那一家 GPT,于是不再并列、直接就是 Codex。
    expect(matchSpokenFamily('让 ChatGPT 帮我写一段')).toMatchObject({ kind: 'one', id: 'codex' })
    expect(canonicalWho('给 minus 发个信息')).toBe('给 minus 发个信息')
  })

  it('★ 没装的那几家不在池里:点名也认不出(不猜一家顶上)', () => {
    setFamilyPool([{ id: 'claude', title: 'Claude' }])
    expect(matchSpokenFamily('让 Manus 查一下').kind).toBe('none')
    expect(matchSpokenFamily('让 Kimi 查一下').kind).toBe('none')
  })

  it('★ 听错的名字换正名用的也是这一池', () => {
    setFamilyPool([...DOWNSTREAM, { id: 'manus', title: 'Manus', aliases: ['马纳斯'] }])
    expect(canonicalWho('给 minus 发个信息')).toBe('给 Manus 发个信息')
  })

  it('★ 一行坏了只丢那一行,不清空整池;整池空 / undefined 才退回兜底', () => {
    setFamilyPool([{ id: 'claude', title: 'Claude' }, { id: '', title: '空的' }, { title: '没 id' }, { id: 'muse' }])
    expect(familyPool()).toEqual([{ id: 'claude', title: 'Claude' }, { id: 'muse', title: 'muse' }])
    setFamilyPool([])
    expect(familyPoolSource()).toBe('fallback')
    setFamilyPool(undefined)
    expect(familyPoolSource()).toBe('fallback')
  })

  it('★ 念那条会话的家名问同一池(从前是第四份写死的四家表,豆包 / Muse / Manus 被念成家名本身)', () => {
    const state = { sessions: [{ agent: 'doubao', status: 'running', title: '润色那段文案', project: '' }] }
    const before = spokenAgentSessions(agentSessionsOf(state))
    expect(before).toContain('豆包办公')
    setFamilyPool([{ id: 'doubao', title: '豆包工作' }])
    expect(spokenAgentSessions(agentSessionsOf(state))).toContain('豆包工作')
    // 池里没有的那一家原样念,不猜一个名字。
    expect(familyTitle('com.unknown.app')).toBe('com.unknown.app')
    // 事务官自己那条不是「一家」,不进池子。
    expect(spokenAgentSessions(agentSessionsOf({ sessions: [{ agent: 'dsh', status: 'running', title: 'x', project: '' }] })))
      .toContain('事务官本体')
  })
})

describe('GET /families —— 三种「没拉到」各说清是哪一种', () => {
  function client(reply: (path: string) => { status: number, body: unknown } | Error) {
    return createWorkbenchClient({
      baseUrl: 'http://127.0.0.1:8791',
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname
        const out = reply(path)
        if (out instanceof Error) throw out
        return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
  }

  it('拉到了:原样带回那几行', async () => {
    const out = await client(() => ({ status: 200, body: { families: DOWNSTREAM } })).families()
    expect(out).toEqual({ ok: true, families: DOWNSTREAM })
  })

  it('★ 连不上 / 旧版 404 / 形状不对:三句话各不相同,一句都不装作拉到了', async () => {
    const offline = await client(() => new Error('ECONNREFUSED')).families()
    expect(offline.ok).toBe(false)
    const old = await client(() => ({ status: 404, body: {} })).families()
    expect(old.ok).toBe(false)
    if (!old.ok) expect(old.note).toContain('旧版')
    const bad = await client(() => ({ status: 200, body: { families: '一串字' } })).families()
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.note).toContain('形状')
  })
})
