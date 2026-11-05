/**
 * **诊断包加两样**(2026-10-02,维护者拍板):为了下次「谁在反复打开某个 App」查得到 ——
 * 10-02 那件「网易云每隔 10s 自行打开」只能写「没查实」。
 *
 * ① 插件这一头每让系统开一个 App 记一行(`appOpenLog.ts`,记在 `runCommand` 那一个口上);
 * ② 工作台日志**每行带时间**(`logStamp.ts`,一处包住 console)。
 *
 * 两条要紧的反面:
 * - 已经自己带了时间的行(`[dispatch]` / `[answer]` 那几行用 `logStampOf`)**不许盖第二个时间**;
 * - `df` / `pgrep` / `launchctl` 那些命令**一行都不记**(记进来只会把真正那几行埋掉)。
 */
import { describe, expect, it } from 'vitest'
import { format } from 'node:util'
import {
  APP_OPEN_TAG, appOpenLogLine, openTargetOf, withOpenCommandLog,
} from '../src/server/appOpenLog.ts'
import {
  LOG_STAMP_RE, STAMPED_METHODS, installLogStamp, logStampOf, stampLogText,
} from '../src/server/logStamp.ts'
import type { ConsoleLike } from '../src/server/logStamp.ts'

/** 2026-10-02 11:27:03 本地时间(日志里那个时间是本地时区的)。 */
const AT = new Date(2026, 9, 2, 11, 27, 3)

describe('工作台日志每行带时间', () => {
  it('没带时间的行盖一个', () => {
    expect(stampLogText('豆包办公:已完成。', AT)).toBe('[11:27:03] 豆包办公:已完成。')
  })

  it('★已经带时间的行不盖第二个(`[answer]` 那几行自己用 logStampOf)', () => {
    const already = `[${logStampOf(AT)}] [answer] claude/1234abcd ← 本机:送进去了`
    expect(stampLogText(already, new Date(2026, 9, 2, 23, 59, 59))).toBe(already)
    expect(LOG_STAMP_RE.test(already)).toBe(true)
  })

  it('一次输出好几行 → 每一行都带时间;空行还是空行', () => {
    expect(stampLogText('第一行\n\n第二行', AT)).toBe('[11:27:03] 第一行\n\n[11:27:03] 第二行')
  })

  it('一处包住 console:五个方法都盖,撤销之后一字不改', () => {
    const seen: string[] = []
    const fake = Object.fromEntries(
      STAMPED_METHODS.map(method => [method, (...args: unknown[]) => { seen.push(`${method}:${String(args[0])}`) }]),
    ) as unknown as ConsoleLike
    const undo = installLogStamp({ console: fake, now: () => AT, format })
    for (const method of STAMPED_METHODS) fake[method]('一句话')
    expect(seen).toEqual(STAMPED_METHODS.map(method => `${method}:[11:27:03] 一句话`))
    undo()
    seen.length = 0
    fake.log('一句话')
    expect(seen).toEqual(['log:一句话'])
  })

  it('`console.log(\'a %s\', \'b\')` 那种拼法照旧(格式化交给 util.format)', () => {
    const seen: string[] = []
    const fake = { log: (line: unknown) => { seen.push(String(line)) } } as unknown as ConsoleLike
    for (const method of STAMPED_METHODS) if (method !== 'log') (fake as Record<string, unknown>)[method] = () => undefined
    const undo = installLogStamp({ console: fake, now: () => AT, format })
    fake.log('派给 %s,第 %d 回', '豆包办公', 2)
    undo()
    expect(seen).toEqual(['[11:27:03] 派给 豆包办公,第 2 回'])
  })

  it('★装两遍只算一遍(热更新重载时不该变成两个时间)', () => {
    const seen: string[] = []
    const fake = Object.fromEntries(
      STAMPED_METHODS.map(method => [method, (...args: unknown[]) => { seen.push(String(args[0])) }]),
    ) as unknown as ConsoleLike
    const undo = installLogStamp({ console: fake, now: () => AT, format })
    const second = installLogStamp({ console: fake, now: () => AT, format })
    fake.log('一句话')
    second()
    undo()
    expect(seen).toEqual(['[11:27:03] 一句话'])
  })
})

describe('开 App 那一行', () => {
  it('`open -b` / `-a` / `-R` / `-n` 各认各的', () => {
    expect(openTargetOf(['open', '-b', 'com.netease.163music'])).toEqual({ way: 'bundle', who: 'com.netease.163music' })
    expect(openTargetOf(['open', '-a', 'Claude'])).toEqual({ way: 'name', who: 'Claude' })
    expect(openTargetOf(['open', '-R', '/tmp/包.zip'])).toEqual({ way: 'reveal', who: '/tmp/包.zip' })
    expect(openTargetOf(['open', '-n', '/Applications/工作台.app', '--args', '--relaunch']))
      .toEqual({ way: 'new', who: '/Applications/工作台.app' })
  })

  it('★深链只留协议头(里面带会话 id,网址里可能带 token)', () => {
    expect(openTargetOf(['open', 'claude://session/abcd-1234?token=secret'])).toEqual({ way: 'url', who: 'claude' })
    expect(openTargetOf(['open', 'http://127.0.0.1:8791/admin?token=secret'])).toEqual({ way: 'url', who: 'http' })
  })

  it('★不是 open 的命令一行都不记', () => {
    expect(openTargetOf(['df', '-h', '/'])).toBeUndefined()
    expect(openTargetOf(['pgrep', '-f', 'dsh'])).toBeUndefined()
    expect(openTargetOf(['launchctl', 'kickstart', '-k', 'gui/501/ai.deepseek.dsh'])).toBeUndefined()
    expect(openTargetOf([])).toBeUndefined()
  })

  it('那一行:时间、哪个包、用哪样开的;没开成就说没开成', () => {
    const target = { way: 'bundle', who: 'com.netease.163music' } as const
    expect(appOpenLogLine({ at: AT, target })).toBe(`[11:27:03] [${APP_OPEN_TAG}] com.netease.163music ← open -b`)
    expect(appOpenLogLine({ at: AT, target, ok: false })).toContain('没开成')
  })

  it('★那一行自己带时间 → 盖时间那一层放过它,不会变成两个时间', () => {
    const line = appOpenLogLine({ at: AT, target: { way: 'bundle', who: 'com.x' } })
    expect(stampLogText(line, new Date(2026, 9, 2, 23, 59, 59))).toBe(line)
  })

  it('包住执行器:open 记一行、别的不记;命令本身的回值一字不改', async () => {
    const lines: string[] = []
    const ran: readonly string[][] = []
    const run = async (cmd: readonly string[]): Promise<{ ok: boolean, stdout: string }> => {
      (ran as string[][]).push([...cmd])
      return { ok: cmd[1] !== '-b', stdout: '原样' }
    }
    const wrapped = withOpenCommandLog(run, { now: () => AT, write: line => { lines.push(line) } })
    expect(await wrapped(['open', '-b', 'com.netease.163music'])).toEqual({ ok: false, stdout: '原样' })
    expect(await wrapped(['df', '-h', '/'])).toEqual({ ok: true, stdout: '原样' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('com.netease.163music')
    expect(lines[0]).toContain('没开成')
    expect(ran).toHaveLength(2)
  })

  it('★记日志坏了不许把命令弄坏', async () => {
    const wrapped = withOpenCommandLog(
      async () => ({ ok: true }),
      { now: () => AT, write: () => { throw new Error('盘满了') } },
    )
    expect(await wrapped(['open', '-b', 'com.x'])).toEqual({ ok: true })
  })
})
