// @vitest-environment node
/**
 * 「装完没自己起来」碰的几条接缝 —— **读源头文件比对**(接缝规矩:改契约同一分支改完所有消费方,
 * 有对照测试就跑、没有就补一条;不写「逐字相同」注释代替测试)。
 *
 * 这一组钉的是**跨三个顶层目录的那几个数与那个名字**(插件 / 壳 / deploy 互不 import):
 *
 * ① DSH 那个 launchd 项的名字:插件 `DSH_LAUNCHD_LABEL` = 壳 `ShellReadiness.dshLaunchdLabel`;
 * ② 壳发的那一下**不带 `-k`**(带了就是"杀掉再起",一个好着的服务会被它弄掉);
 * ③ 壳等的那 20 秒必须**大于** plist 里的 `ThrottleInterval` —— 不然刚被 kickstart 过、
 *    还在 launchd 的节流里就又拉一次;
 * ④ plist 里 `KeepAlive.SuccessfulExit=false` 还在:整条「以非 0 退出让 launchd 拉起」的
 *    保险全靠它(它要是哪天变成 true,`hardRestart` 那一下就成了"把服务关掉");
 * ⑤ 发版脚本等不到服务时,打的是 `launchctl print` 的读数 + 救法,不是「自己看一眼」。
 *
 * 机理与那六个读数见 `docs/交接-1013-热更新装完重启没起来.md`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DSH_LAUNCHD_LABEL } from '../src/server/setup/paths.ts'
import { restartHandoffCommand } from '../src/server/update/apply.ts'

const ROOT = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

describe('重启那一下的接缝(2026-10-13)', () => {
  it('① 壳认的 launchd 项名字与插件这一份逐字相同', () => {
    const shell = read('workbench-app/Sources/ShellReadiness.swift')
    expect(/static let dshLaunchdLabel = "([^"]+)"/.exec(shell)?.[1]).toBe(DSH_LAUNCHD_LABEL)
  })

  it('② 壳发的是不带 -k 的 kickstart,插件装完发的才带 -k', () => {
    const shell = read('workbench-app/Sources/ShellReadiness.swift')
    const args = /static func kickstartArguments\(uid: UInt32\) -> \[String\] \{([\s\S]*?)\n    \}/.exec(shell)?.[1] ?? ''
    expect(args).toContain('"kickstart"')
    expect(args).not.toContain('-k')
    // 插件这一头相反:装完那一下就是要"杀掉再起"(新代码在磁盘上,内存里还是旧的)。
    expect(restartHandoffCommand(`gui/501/${DSH_LAUNCHD_LABEL}`, 0).join(' ')).toContain('kickstart -k')
  })

  it('③ 壳等的那个数大于 plist 里的 ThrottleInterval', () => {
    const shell = read('workbench-app/Sources/ShellReadiness.swift')
    const waited = Number(/static let kickstartAfter: TimeInterval = (\d+)/.exec(shell)?.[1])
    const throttle = Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(read('deploy/ai.deepseek.dsh.plist'))?.[1])
    expect(Number.isFinite(waited)).toBe(true)
    expect(Number.isFinite(throttle)).toBe(true)
    expect(waited).toBeGreaterThan(throttle)
  })

  it('④ plist 里「正常退出不拉起、非正常退出拉起」那一条还在', () => {
    const plist = read('deploy/ai.deepseek.dsh.plist')
    expect(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist)).toBe(true)
  })

  it('⑤ 发版脚本等不到服务时打的是读数与救法,不是「自己看一眼」', () => {
    const script = read('deploy/publish-update.sh')
    // 那一支真去打读数(别又退回一句「自己看一眼 /state」)。
    const branch = script.slice(script.indexOf('本机工作台还没应答'))
    expect(branch.slice(0, 400)).toContain('launchd_readout')
    const readout = script.slice(script.indexOf('launchd_readout() {'))
    expect(readout).toContain('launchctl print')
    // 读数要含那三个数:state / runs / last exit —— 少一个就下不了结论。
    expect(/grep -E '\^\[\[:space:\]\]\+\(state\|runs\|pid\|last exit\)/.test(readout)).toBe(true)
    // 脚本里的 label 与插件这一份逐字相同,救法那一句不带 -k。
    expect(/local label="([^"]+)"/.exec(readout)?.[1]).toBe(DSH_LAUNCHD_LABEL)
    expect(readout).toContain('launchctl kickstart gui/\\$(id -u)/${label}')
    expect(readout.slice(0, readout.indexOf('local_apply()'))).not.toContain('kickstart -k')
  })
})
