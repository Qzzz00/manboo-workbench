// @vitest-environment node
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTasksService } from '../src/server/tasks.ts'
import { cronMatches, parseCron } from '../src/server/collabCron.ts'
import { sanitizeNoteFields } from '../src/server/collabStore.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)

async function svc() {
  const file = join(await mkdtemp(join(tmpdir(), 'collab-full-')), 'tasks.json')
  let n = 0
  return createTasksService({ file, now: () => NOW_SEC, newId: () => `t-${++n}` })
}

describe('便签的时间、类型、协作、小队、PR', () => {
  it('读写往返;end 早于 start 就丢 end;认不出的类型挑掉', () => {
    expect(sanitizeNoteFields({
      start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T09:00:00+08:00', work_type: 'dev',
      collaborators: ['me', 'codex'], squad_id: 'sq-1', pull_requests: ['ben/workbench#12'],
    })).toEqual({
      start: '2026-10-21T10:00:00+08:00', work_type: 'dev', collaborators: ['me', 'codex'], squad_id: 'sq-1', pull_requests: ['ben/workbench#12'],
    })
    expect(sanitizeNoteFields({ start: '明天', work_type: '瞎写' })).toEqual({})
  })
  it('服务:改时间只走明确字段;null 清掉', async () => {
    const tasks = await svc()
    await tasks.create({ title: 'a', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', workType: 'meeting' })
    expect((await tasks.list()).tasks[0]).toMatchObject({ start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', work_type: 'meeting' })
    await tasks.update('t-1', { start: null, end: null, collaborators: ['claude'], pullRequests: ['a/b#1'] })
    const note = (await tasks.list()).tasks[0]
    expect(note?.start).toBeUndefined()
    expect(note?.end).toBeUndefined()
    expect(note).toMatchObject({ collaborators: ['claude'], pull_requests: ['a/b#1'] })
  })
})

describe('小队', () => {
  it('建、改、删;删小队不动任何便签', async () => {
    const tasks = await svc()
    const made = await tasks.saveSquad({ name: '前端组', leader: 'me', members: ['codex', 'claude'] })
    expect(made.ok).toBe(true)
    await tasks.create({ title: 'a', squadId: made.id as string })
    await tasks.saveSquad({ id: made.id as string, members: ['codex'] })
    expect((await tasks.list()).squads).toMatchObject([{ id: made.id, name: '前端组', leader: 'me', members: ['codex'] }])
    expect(await tasks.removeSquad(made.id as string)).toBe(true)
    const after = await tasks.list()
    expect(after.squads).toEqual([])
    expect(after.tasks[0]?.squad_id).toBe(made.id)
  })
  it('没名字、没组长不建', async () => {
    const tasks = await svc()
    expect((await tasks.saveSquad({ name: '', leader: 'me' })).ok).toBe(false)
    expect((await tasks.saveSquad({ name: 'x', leader: '' })).ok).toBe(false)
  })
})

describe('定时派活:存与运行记录', () => {
  it('建一条 cron;记运行,最多 20 条,新的在后', async () => {
    const tasks = await svc()
    const made = await tasks.saveTimer({ name: '周报', trigger: { kind: 'cron', cron: '0 9 * * 1' }, assignee: 'codex', template: { title: '写周报', acceptance: ['发到群里'] } })
    expect(made.ok).toBe(true)
    for (let i = 0; i < 22; i += 1) await tasks.recordTimerRun(made.id as string, { at: `2026-10-21T09:${String(i).padStart(2, '0')}:00.000Z`, ok: true })
    const timer = (await tasks.list()).timers?.[0]
    expect(timer?.runs).toHaveLength(20)
    expect(timer?.runs.at(-1)?.at).toBe('2026-10-21T09:21:00.000Z')
    expect(timer).toMatchObject({ name: '周报', enabled: true, trigger: { kind: 'cron', cron: '0 9 * * 1' } })
  })
  it('cron 写错不存;webhook 只存,地址缺席', async () => {
    const tasks = await svc()
    expect((await tasks.saveTimer({ name: 'x', trigger: { kind: 'cron', cron: '99 * * * *' }, assignee: 'codex', template: { title: 'a', acceptance: ['b'] } })).ok).toBe(false)
    const hook = await tasks.saveTimer({ name: 'y', trigger: { kind: 'webhook' }, assignee: 'codex', template: { title: 'a', acceptance: ['b'] } })
    expect(hook.ok).toBe(true)
    expect((await tasks.list()).timers?.[0]?.trigger).toEqual({ kind: 'webhook' })
  })
  it('模板没写验收不存(到点建出来的便签也要过四样的门)', async () => {
    const tasks = await svc()
    expect((await tasks.saveTimer({ name: 'x', trigger: { kind: 'cron', cron: '* * * * *' }, assignee: 'codex', template: { title: 'a', acceptance: [] } })).ok).toBe(false)
  })
})

describe('最小 cron', () => {
  it('分 时 日 月 周;* 数字 逗号 */n', () => {
    const at = (iso: string) => new Date(iso)
    expect(parseCron('0 9 * * 1')).toBeDefined()
    expect(parseCron('61 * * * *')).toBeUndefined()
    expect(parseCron('* * *')).toBeUndefined()
    const cron = parseCron('*/15 9,18 * * 1-5')
    expect(cron).toBeUndefined() // 范围(1-5)不认:只认 * 数字 逗号 */n
    const weekdayNine = parseCron('0,30 9 * * 1,2,3,4,5')
    expect(weekdayNine !== undefined && cronMatches(weekdayNine, at('2026-10-21T09:30:00'))).toBe(true) // 周三
    expect(weekdayNine !== undefined && cronMatches(weekdayNine, at('2026-10-25T09:30:00'))).toBe(false) // 周日
    const every = parseCron('*/15 * * * *')
    expect(every !== undefined && cronMatches(every, at('2026-10-21T09:45:00'))).toBe(true)
    expect(every !== undefined && cronMatches(every, at('2026-10-21T09:44:00'))).toBe(false)
  })
})

describe('工作室 MCP 库(条目)', () => {
  it('建、改、删;密钥只记名字', async () => {
    const tasks = await svc()
    const made = await tasks.saveMcp({ name: 'Figma', url_template: 'https://mcp.figma.com/{token}', secret_names: ['FIGMA_TOKEN'] })
    expect(made.ok).toBe(true)
    expect((await tasks.list()).mcp).toMatchObject([{ name: 'Figma', secret_names: ['FIGMA_TOKEN'] }])
    expect(await tasks.removeMcp(made.id as string)).toBe(true)
    expect((await tasks.list()).mcp).toEqual([])
  })
  it('密钥名只许字母数字下划线', async () => {
    const tasks = await svc()
    expect((await tasks.saveMcp({ name: 'x', url_template: 'u', secret_names: ['a b'] })).ok).toBe(false)
  })
})
