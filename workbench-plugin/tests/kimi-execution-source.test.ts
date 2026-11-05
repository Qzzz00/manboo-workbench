// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createKimiExecutionLocator, locateKimiCliSession } from '../src/server/cliSessionRead.ts'
import { kimiExecutionEvents } from '../src/server/codexExecutionFacts.ts'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-source-'))); dirs.push(home)
  const cwd = join(home, 'project'); mkdirSync(cwd)
  const sessionId = 'session-qa-source', dir = join(home, '.kimi-code', 'sessions', 'workspace', sessionId)
  mkdirSync(join(dir, 'agents', 'main'), { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ cwd }))
  const file = join(dir, 'agents', 'main', 'wire.jsonl'); writeFileSync(file, '{}\n')
  return { home, cwd, sessionId, dir, file }
}
describe('Kimi精确来源与项目门', () => {
  it('只定位已登记id，主agent与项目内工作树可读；别的项目不读', async () => {
    const f = fixture(), child = join(f.cwd, '.claude', 'worktrees', 'qa'); mkdirSync(child, { recursive: true })
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({ cwd: child }))
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd] })).toMatchObject({ format: 'kimi-wire', file: f.file })
    const other = join(f.home, 'other'); mkdirSync(other)
    expect(await locateKimiCliSession({ ...f, cwds: [other] })).toBeUndefined()
  })
  it('原件或metadata软链出会话根时拒绝；不读取软链所指正文', async () => {
    const f = fixture(), outside = join(f.home, 'outside.jsonl'); writeFileSync(outside, '{}')
    rmSync(f.file); symlinkSync(outside, f.file)
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd], registeredFile: f.file })).toBeUndefined()
    rmSync(f.file); writeFileSync(f.file, '{}\n'); rmSync(join(f.dir, 'state.json')); symlinkSync(outside, join(f.dir, 'state.json'))
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd], registeredFile: f.file })).toBeUndefined()
  })
  it('同id对应两个项目匹配原件时不猜第一份', async () => {
    const f = fixture(), second = join(f.home, '.kimi-code', 'sessions', 'other-workspace', f.sessionId)
    mkdirSync(second, { recursive: true }); writeFileSync(join(second, 'wire.jsonl'), '{}'); writeFileSync(join(second, 'state.json'), JSON.stringify({ cwd: f.cwd }))
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd] })).toBeUndefined()
  })
  it('大量 workspace 时只探测精确会话目录，仍拒绝第二份同 id 来源', async () => {
    const f = fixture()
    for (let group = 0; group < 162; group++) mkdirSync(join(f.home, '.kimi-code', 'sessions', `extra-${group}`))
    let probes = 0
    const statFile = async (path: string) => { probes++; return stat(path) }
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd], statFile })).toMatchObject({ file: f.file })
    expect(probes).toBeGreaterThan(0)
    expect(probes).toBeLessThan(400)
    const second = join(f.home, '.kimi-code', 'sessions', 'extra-0', f.sessionId)
    mkdirSync(second); writeFileSync(join(second, 'wire.jsonl'), '{}'); writeFileSync(join(second, 'state.json'), JSON.stringify({ cwd: f.cwd }))
    expect(await locateKimiCliSession({ ...f, cwds: [f.cwd], statFile })).toBeUndefined()
  })
  it('执行快照路径提示逐拍核源，新增重复、项目撤权、原件失联与重启均立即生效', async () => {
    const f = fixture()
    for (let group = 0; group < 162; group++) mkdirSync(join(f.home, '.kimi-code', 'sessions', `extra-${group}`))
    let probes = 0
    const counted = ((path: string, options?: { bigint?: boolean }) => { probes++; return stat(path, options as never) }) as typeof stat
    const locator = createKimiExecutionLocator(f.home, counted)
    const locate = async (cwds = [f.cwd]) => (await locator.prepare())({ sessionId: f.sessionId, cwds })
    expect(await locate()).toMatchObject({ file: f.file })
    const coldProbes = probes; probes = 0
    expect(await locate()).toMatchObject({ file: f.file })
    expect(probes).toBeLessThan(coldProbes / 2)
    const other = join(f.home, 'other'); mkdirSync(other)
    expect(await locate([other])).toBeUndefined()
    expect(await locate()).toMatchObject({ file: f.file })
    const second = join(f.home, '.kimi-code', 'sessions', 'extra-0', f.sessionId)
    mkdirSync(second); writeFileSync(join(second, 'wire.jsonl'), '{}'); writeFileSync(join(second, 'state.json'), JSON.stringify({ cwd: f.cwd }))
    expect(await locate()).toBeUndefined()
    rmSync(second, { recursive: true })
    expect(await locate()).toMatchObject({ file: f.file })
    rmSync(f.file)
    expect(await locate()).toBeUndefined()
    writeFileSync(f.file, '{}\n')
    expect(await locate()).toMatchObject({ file: f.file })
    const restarted = createKimiExecutionLocator(f.home)
    expect(await (await restarted.prepare())({ sessionId: f.sessionId, cwds: [f.cwd] })).toMatchObject({ file: f.file })
  })
  it('prompt和usage不算执行；包裹式TurnBegin/TurnEnd各自保留稳定来源轮', () => {
    const rows = [ { type: 'metadata', protocol_version: '1.10' }, { type: 'turn.prompt', time: 1793000000000, input: { content: 'private prompt' } }, { type: 'usage.record', time: 1793000001000 } ]
    expect(kimiExecutionEvents(rows.map(row => JSON.stringify(row)).join('\n'), 'session-qa')).toEqual([])
    const raw = [ ...rows, { timestamp: 1793000002, message: { type: 'TurnBegin', payload: { turn_id: 'r-1' } } }, { timestamp: 1793000003, message: { type: 'TurnEnd', payload: {} } } ].map(row => JSON.stringify(row)).join('\n')
    const events = kimiExecutionEvents(raw, 'session-qa')
    expect(events.map(event => [event.round, event.kind])).toEqual([['r-1', 'started'], ['r-1', 'ended']])
    expect(events).toEqual(kimiExecutionEvents(raw, 'session-qa')); expect(JSON.stringify(events)).not.toContain('private prompt')
  })
})
