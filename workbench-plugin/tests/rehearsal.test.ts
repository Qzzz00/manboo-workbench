// @vitest-environment node
/**
 * 新机器演练的判法与报告(2026-10-21,内测发版底座)。`scripts/rehearse.ts` 是薄壳,逻辑都在这里。
 *
 * 钉四件事:
 * 1. **演练不碰这台真机**:改她程序坞与菜单栏的那一步不跑,launchctl / defaults / killall 这几条被挡;
 * 2. 体检的每一项分成四档:都在 / **没成**(新装的机器上本该有却没有 = 红) / **缺的门**(要她自己点、登录的) / 演练里不判;
 * 3. 只有「安装没走完」与「没成」让整趟变红 —— 缺的门是新机器的常态,不算;
 * 4. 报告是一份能直接贴进交接的 Markdown:成 / 没成 / 缺哪道门 / 用时。
 */
import { describe, expect, it } from 'vitest'
import { INSTALLER_STEPS } from '../src/server/setup/installer.ts'
import {
  checkRowsFromSelfChecks, checkRowsFromSetup, installStepsOf, parseRehearseArgs, rehearsalVerdict,
  REHEARSAL_MUST_HAVE, REHEARSAL_SHIMMED_COMMANDS, REHEARSAL_SKIPPED_STEPS, renderRehearsalReport,
  type RehearsalResult,
} from '../src/server/setup/rehearsal.ts'
import type { SetupItem } from '../src/server/setup/types.ts'

const T0 = Date.parse('2026-10-21T09:00:00.000Z')

function item(key: string, state: SetupItem['state'], over: Partial<SetupItem> = {}): SetupItem {
  return { key, label: key, state, detail: `${key} 的事实`, step: 1, ...over }
}

function result(over: Partial<RehearsalResult> = {}): RehearsalResult {
  return {
    version: '0.4.143',
    startedAt: T0,
    finishedAt: T0 + 192_000,
    pkg: { kind: 'dmg', path: '/Users/example/repo/dist/工作台安装器-0.4.143.dmg', sha256: 'ab'.repeat(32), built: false },
    box: '/var/folders/xx/wb-rehearse-abc',
    kept: false,
    installerExit: 0,
    steps: [
      { key: 'node', title: '正在准备运行环境…', state: 'ok', ms: 4_000 },
      { key: 'runtime', title: '正在下载工作台的运行时…', state: 'ok', ms: 95_000 },
      { key: 'desktop', title: '正在把桌面整理一下…', state: 'skip', detail: '演练里不跑' },
    ],
    checkSource: 'five_step',
    checks: checkRowsFromSetup([
      item('node', 'ok'),
      item('runtime', 'ok'),
      item('accessibility', 'needs_user', { step: 3, label: '辅助功能授权', fix: '去系统设置里点允许' }),
      item('launchd_dsh', 'missing'),
    ]),
    logTail: [],
    ...over,
  }
}

describe('演练不碰这台真机', () => {
  it('改程序坞与菜单栏的那一步不跑;它确实是安装器里的一步(改名了这里要跟着改)', () => {
    expect(REHEARSAL_SKIPPED_STEPS).toEqual(['desktop'])
    expect(INSTALLER_STEPS.map(step => step.key)).toContain('desktop')
  })

  it('launchctl / defaults / killall 被挡在 PATH 最前面', () => {
    for (const cmd of ['launchctl', 'defaults', 'killall']) expect(REHEARSAL_SHIMMED_COMMANDS).toContain(cmd)
  })
})

describe('安装那几步:成 / 跳过 / 没成 / 没走到,各用了多久', () => {
  it('按事件的时刻切:一步从它开始到下一步开始;停在哪一步就是哪一步没成,后面的没走到', () => {
    const rows = installStepsOf([
      { at: T0, event: { t: 'begin', total: 3 } },
      { at: T0 + 10, event: { t: 'step', i: 1, n: 3, key: 'node', title: '准备运行环境' } },
      { at: T0 + 4_010, event: { t: 'step', i: 2, n: 3, key: 'runtime', title: '下载运行时' } },
      { at: T0 + 9_010, event: { t: 'fail', key: 'runtime', title: '下载运行时', error: 'npm 连不上', tail: ['ERR'], optional: false } },
    ], [{ key: 'node', title: '准备运行环境' }, { key: 'runtime', title: '下载运行时' }, { key: 'plugin', title: '装工作台' }], T0 + 9_500)
    expect(rows).toEqual([
      { key: 'node', title: '准备运行环境', state: 'ok', ms: 4_000 },
      { key: 'runtime', title: '下载运行时', state: 'fail', ms: 5_000, detail: 'npm 连不上' },
      { key: 'plugin', title: '装工作台', state: 'not_run' },
    ])
  })

  it('可选步骤跳过 → skip 并带原因;装完(done)那一刻收尾最后一步', () => {
    const rows = installStepsOf([
      { at: T0, event: { t: 'step', i: 1, n: 2, key: 'butler', title: '装事务官' } },
      { at: T0 + 100, event: { t: 'skip', key: 'butler', why: '这一版没带' } },
      { at: T0 + 200, event: { t: 'step', i: 2, n: 2, key: 'shell', title: '放进应用程序' } },
      { at: T0 + 700, event: { t: 'done', shell_app: '/x', work_repo: '/y' } },
    ], [{ key: 'butler', title: '装事务官' }, { key: 'shell', title: '放进应用程序' }], T0 + 900)
    expect(rows[0]).toEqual({ key: 'butler', title: '装事务官', state: 'skip', ms: 200, detail: '这一版没带' })
    expect(rows[1]).toEqual({ key: 'shell', title: '放进应用程序', state: 'ok', ms: 500 })
  })
})

describe('体检的四档', () => {
  it('★新装的机器上本该有的那几样没有 → 没成(红)', () => {
    for (const key of REHEARSAL_MUST_HAVE) {
      const [row] = checkRowsFromSetup([item(key, 'missing')])
      expect(row?.state, key).toBe('red')
    }
  })

  it('要她自己点、自己登录的 → 缺的门,带上怎么办;可选的没装也是门,不是红', () => {
    const rows = checkRowsFromSetup([
      item('accessibility', 'needs_user', { step: 3, fix: '去系统设置里点允许' }),
      item('deepseek_key', 'missing', { step: 4 }),
      item('client_claude', 'missing', { step: 5, optional: true }),
      item('channel_worker', 'missing', { optional: true }),
    ])
    expect(rows.map(row => row.state)).toEqual(['gate', 'gate', 'gate', 'gate'])
    expect(rows[0]?.detail).toContain('去系统设置里点允许')
  })

  it('开机自启与网页登录态演练里不判(不装载、不起服务),说清为什么', () => {
    const rows = checkRowsFromSetup([item('launchd_dsh', 'missing'), item('web_cookie', 'missing', { step: 3 })])
    expect(rows.map(row => row.state)).toEqual(['skip', 'skip'])
    expect(rows[0]?.detail).toContain('不装载')
  })

  it('引导卡的三件自检(接上之后)同一套档:成 / 缺门 / 没成', () => {
    const rows = checkRowsFromSelfChecks([
      { key: 'brief', title: '出一份早报', ok: true, detail: '出了' },
      { key: 'dispatch', title: '派一件活', ok: false, gate: '没登录 Claude 或 Codex', detail: '没派出去' },
      { key: 'call', title: '自拨一通', ok: false, detail: '工人没起来' },
    ])
    expect(rows.map(row => row.state)).toEqual(['ok', 'gate', 'red'])
    expect(rows[1]?.detail).toContain('没登录 Claude 或 Codex')
  })
})

describe('结论与报告', () => {
  it('★缺的门不让整趟变红;安装没走完或有「没成」才红', () => {
    expect(rehearsalVerdict(result()).ok).toBe(true)
    expect(rehearsalVerdict(result({ installerExit: 2 })).ok).toBe(false)
    expect(rehearsalVerdict(result({ installerExit: null, installerError: '内核没起来' })).ok).toBe(false)
    const red = rehearsalVerdict(result({ checks: checkRowsFromSetup([item('runtime', 'missing')]) }))
    expect(red.ok).toBe(false)
    expect(red.reds.join('\n')).toContain('runtime')
    const stepFail = rehearsalVerdict(result({ steps: [{ key: 'plugin', title: '装工作台', state: 'fail', ms: 1, detail: '坏了' }] }))
    expect(stepFail.ok).toBe(false)
  })

  it('报告:标题带版本与成/没成;有用时、安装包、几道门;路径里的用户名换掉', () => {
    const text = renderRehearsalReport(result())
    expect(text.split('\n')[0]).toBe('# 新机器演练 · 0.4.143 · 成')
    expect(text).toContain('3 分 12 秒')
    expect(text).toContain('工作台安装器-0.4.143.dmg')
    expect(text).toContain('## 缺哪道门')
    expect(text).toContain('辅助功能授权')
    expect(text).toContain('五步体检')
    expect(text).not.toContain('/Users/example')
    const failed = renderRehearsalReport(result({ installerExit: 2, logTail: ['npm ERR! 连不上'] }))
    expect(failed.split('\n')[0]).toBe('# 新机器演练 · 0.4.143 · 没成')
    expect(failed).toContain('npm ERR! 连不上')
  })

  it('引导卡三件自检那一节:单独一节;它里面有「没成」也让整趟变红', () => {
    const selfChecks = checkRowsFromSelfChecks([{ key: 'call', title: '打个电话', ok: false, gate: 'phone', detail: '打个电话:手机没配对' }])
    const text = renderRehearsalReport(result({ selfChecks }))
    expect(text).toContain('## 装完自检三件')
    expect(text).toContain('手机没配对')
    expect(rehearsalVerdict(result({ selfChecks })).ok).toBe(true)
    const red = checkRowsFromSelfChecks([{ key: 'call', title: '打个电话', ok: false, detail: '坏了' }])
    expect(rehearsalVerdict(result({ selfChecks: red })).ok).toBe(false)
  })
})

describe('参数', () => {
  it('认 --version / --dmg / --resources / --report / --keep / --no-build;dmg 与 resources 只能给一个', () => {
    const ok = parseRehearseArgs(['--version', '0.4.143', '--dmg', '/a.dmg', '--report', '/r.md', '--keep', '--no-build'])
    expect(ok).toEqual({ ok: true, args: { version: '0.4.143', dmg: '/a.dmg', report: '/r.md', keep: true, build: false } })
    expect(parseRehearseArgs([])).toEqual({ ok: true, args: { keep: false, build: true } })
    expect(parseRehearseArgs(['--dmg', '/a.dmg', '--resources', '/r']).ok).toBe(false)
    expect(parseRehearseArgs(['--bogus']).ok).toBe(false)
    expect(parseRehearseArgs(['--version']).ok).toBe(false)
  })
})
