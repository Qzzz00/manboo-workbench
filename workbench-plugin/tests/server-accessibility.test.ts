/**
 * 「开关在、壳仍报未授权」那一种(2026-09-18,分支 fix/landscape-firstrun-glitches)。
 *
 * Ben 真机原话(截图第三处):
 *
 * > 「实际情况是系统设置里『工作台』开关是开着的,但那条记录对应的是旧签名的壳。」
 *
 * 顶上那条横幅当时照着老口径说「还差一个授权:辅助功能」—— 他已经把开关打开了,
 * 照着这句话再走一遍毫无用处。这份用例钉的是**服务端怎么判出这是哪一种**:
 * 直接证据(TCC 里那条记录)优先,探不到(常态)才退回间接证据(壳的签名种类)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  accessibilityKindOf, alertKindOf, grantHistoryOf, parseDesignatedRequirement, parseGrantRecord, parseShellSignature, parseTccCount, probeTccRecord,
  SHELL_BUNDLE_ID,
} from '../src/server/setup/accessibility.ts'
import type { SetupIo } from '../src/server/setup/io.ts'

const CERT_DR = 'Executable=/Applications/工作台.app/Contents/MacOS/workbench\ndesignated => identifier "ai.ben.workbench" and certificate leaf = H"dfec52eaf2ac63532dfbbe20e6f8a1a7ab07897a"\n'
const ADHOC_DR = 'Executable=/Applications/工作台.app/Contents/MacOS/workbench\n# designated => cdhash H"e1d685945e7f7a276f95508671ac275aee8cd6c1"\n'

describe('读签名(parseShellSignature)', () => {
  it('certificate leaf ⇒ 固定证书(TCC 认的那条线跨重建不变)', () => {
    expect(parseShellSignature(CERT_DR)).toBe('certificate')
  })

  it('cdhash ⇒ ad-hoc(每次重建都换,系统当成另一个 App)', () => {
    expect(parseShellSignature(ADHOC_DR)).toBe('adhoc')
  })

  it('读不出来就说读不出来,不猜(D13)', () => {
    expect(parseShellSignature('')).toBe('unknown')
    expect(parseShellSignature('codesign: 工作台.app: code object is not signed at all')).toBe('unknown')
  })
})

describe('数 TCC 记录(parseTccCount)', () => {
  it('干净的整数才算数', () => {
    expect(parseTccCount('1\n')).toBe('present')
    expect(parseTccCount('  0  ')).toBe('absent')
  })

  it('★sqlite3 报错时一律 unknown —— 把一句错误当成 0 就是编出「探到了、没有记录」', () => {
    expect(parseTccCount('Error: unable to open database file')).toBe('unknown')
    expect(parseTccCount('Error: authorization denied')).toBe('unknown')
    expect(parseTccCount('')).toBe('unknown')
  })
})

function ioWith(exec: SetupIo['exec']): SetupIo {
  return { exec } as unknown as SetupIo
}

describe('探一眼 TCC(probeTccRecord)', () => {
  it('查的是系统那份库、问的是壳的 bundle id,而且是 -readonly', async () => {
    const exec = vi.fn(async (_cmd: readonly string[]) => ({ ok: true, code: 0, out: '1\n' }))
    const record = await probeTccRecord(ioWith(exec as unknown as SetupIo['exec']))
    expect(record).toBe('present')
    const cmd = exec.mock.calls[0]![0]
    expect(cmd[0]).toBe('sqlite3')
    expect(cmd).toContain('-readonly')
    expect(cmd[2]).toBe('/Library/Application Support/com.apple.TCC/TCC.db')
    expect(cmd[3]).toContain(SHELL_BUNDLE_ID)
    expect(cmd[3]).toContain('kTCCServiceAccessibility')
  })

  it('★读不动(Ben 这台机器上的常态:那份库只有 root 读得了)⇒ unknown,不是 absent', async () => {
    const exec = (async () => ({ ok: false, code: 1, out: 'Error: unable to open database file' })) as unknown as SetupIo['exec']
    expect(await probeTccRecord(ioWith(exec))).toBe('unknown')
  })

  it('sqlite3 压根不在 / spawn 抛了 ⇒ 同样 unknown,不让一次探测失败拖垮体检', async () => {
    const exec = (async () => { throw new Error('spawn sqlite3 ENOENT') }) as unknown as SetupIo['exec']
    expect(await probeTccRecord(ioWith(exec))).toBe('unknown')
  })
})

describe('判是哪一种(accessibilityKindOf)', () => {
  const connected = { connected: true, authorized: false }

  it('壳没接线 / 没连上 ⇒ unreachable(这不是"没授权",是"看不到")', () => {
    expect(accessibilityKindOf({ helper: undefined, signature: 'certificate', record: 'unknown' })).toBe('unreachable')
    expect(accessibilityKindOf({ helper: { connected: false, authorized: false }, signature: 'certificate', record: 'present' })).toBe('unreachable')
  })

  it('连上且已授权 ⇒ ok', () => {
    expect(accessibilityKindOf({ helper: { connected: true, authorized: true }, signature: 'adhoc', record: 'absent' })).toBe('ok')
  })

  it('★探到 TCC 里真有那条记录 + 壳报未授权 ⇒ stale_record(就是 Ben 遇到的那一幕)', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'adhoc', record: 'present' })).toBe('stale_record')
  })

  it('★探到 TCC 里没有那条记录 ⇒ unauthorized,哪怕壳是证书签名的(直接证据压过间接证据)', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'absent' })).toBe('unauthorized')
  })

  it('★探不到(常态)+ 证书签名 + 这台机器以前授权过另一个签名 ⇒ stale_record', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'unknown', grant: 'changed' })).toBe('stale_record')
  })

  it('★2026-09-23:探不到 + 证书签名 + 从没见过授权(新机器)⇒ unauthorized,不让新用户去删不存在的记录', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'unknown', grant: 'never' })).toBe('unauthorized')
    // 不带 grant(老调用方)同样按「从没见过」读 —— 拿不准时往「还没授权」那边说。
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'unknown' })).toBe('unauthorized')
  })

  it('探不到 + 授权过的就是现在这个签名 / 现在签名读不出来 ⇒ unauthorized', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'unknown', grant: 'same' })).toBe('unauthorized')
    expect(accessibilityKindOf({ helper: connected, signature: 'certificate', record: 'unknown', grant: 'unknown' })).toBe('unauthorized')
  })

  it('探不到 + ad-hoc 签名,哪怕签名换过 ⇒ unauthorized(ad-hoc 的话术是「关一次再开」)', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'adhoc', record: 'unknown', grant: 'changed' })).toBe('unauthorized')
  })

  it('探不到 + 壳是 ad-hoc / 签名读不出来 ⇒ unauthorized(ad-hoc 掉授权是它的常态,说「旧记录」就是猜)', () => {
    expect(accessibilityKindOf({ helper: connected, signature: 'adhoc', record: 'unknown' })).toBe('unauthorized')
    expect(accessibilityKindOf({ helper: connected, signature: 'unknown', record: 'unknown' })).toBe('unauthorized')
  })
})

describe('结论 → 横幅要不要分种类(alertKindOf)', () => {
  it('ok 与 unreachable 都不分种类:前者没话说,后者谈不上"哪一种没授权"', () => {
    expect(alertKindOf('ok')).toBeUndefined()
    expect(alertKindOf('unreachable')).toBeUndefined()
  })

  it('两种"没授权"各自带出去', () => {
    expect(alertKindOf('unauthorized')).toBe('unauthorized')
    expect(alertKindOf('stale_record')).toBe('stale_record')
  })
})

describe('授权来历(grantHistoryOf / parseGrantRecord / parseDesignatedRequirement)', () => {
  it('没记过 ⇒ never;一样 ⇒ same;不一样 ⇒ changed;现在读不出 ⇒ unknown', () => {
    expect(grantHistoryOf(undefined, 'x')).toBe('never')
    expect(grantHistoryOf('x', 'x')).toBe('same')
    expect(grantHistoryOf('x', 'y')).toBe('changed')
    expect(grantHistoryOf('x', undefined)).toBe('unknown')
  })

  it('坏文件 / 空 requirement 当没记过', () => {
    expect(parseGrantRecord(undefined)).toBeUndefined()
    expect(parseGrantRecord('{坏')).toBeUndefined()
    expect(parseGrantRecord(JSON.stringify({ requirement: '' }))).toBeUndefined()
    expect(parseGrantRecord(JSON.stringify({ requirement: 'cdhash H"1"' }))).toBe('cdhash H"1"')
  })

  it('codesign 输出里取 designated => 后面那一整条', () => {
    expect(parseDesignatedRequirement('Executable=/x\ndesignated => identifier "a" and certificate leaf = H"b"\n')).toBe('identifier "a" and certificate leaf = H"b"')
    expect(parseDesignatedRequirement('code object is not signed at all')).toBeUndefined()
  })
})
