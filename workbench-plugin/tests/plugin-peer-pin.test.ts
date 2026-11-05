// @vitest-environment node
/**
 * 守门:peer 必须钉在「我们真编译的那一版上游」上(2026-09-25 升级卡 U2)。
 *
 * ## 为什么要这一份
 *
 * DSH 0.1.7 起插件管理器**装之前**先算 peer:`packages/boot/app-boot/src/plugin-compatibility.ts`
 * 把 package.json 里每一条名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer 拿去跟
 * **运行时 dsh 的版本**比(`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`),
 * 不满足就判不兼容 —— 空范围、写错的范围一律算不满足,得维护者手动 `dsh plugin allow-version` 才装得上。
 * 0.1.2 时代没有这道门,peer 写歪了也照装,所以以前没人守。
 *
 * 两条容易犯的错,这份都拦:
 *
 * 1. **写成 `^0.1.7`**:`includePrerelease` 下 `^0.1.7` 展开成 `>=0.1.7 <0.2.0`,而 `0.1.7-rc.2`
 *    比 `0.1.7` **小**,匹配不上 —— 用户那台会在装插件那一步被拒,而开发机上编译、测试全绿看不出来。
 *    所以预发布线上 peer 只写精确值(也正好合 PRD C3「锁死 DSH 版本」:换版本只能由我们发一版)。
 * 2. **换了上游 checkout 却忘了改 peer**:所以这里不跟一个写死的字符串比,而是跟
 *    `node_modules/@deepseek-ai/*` 真指着的那一版比 —— 切了 tag、重装了依赖、peer 没跟上,这一条就红。
 *    (`client-onboarding-gate.test.ts` 也是这个路子:拿真上游源码给自己的假设做自检。)
 *
 * 红了怎么办:先看 `node_modules/@deepseek-ai/dsh-client-ui-slots/package.json` 的 version 是几,
 * 那就是这台机器上游 checkout 的版本;peer 的九条与它对齐即可。锁定清单那一半(`LOCKED_DSH_VERSION`、
 * `runtime.package{,-lock}.json`)是另一张卡(U1)守的,由 `dsh-runtime-lock.test.ts` 管。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

interface Manifest {
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest

/** 只有这个前缀的 peer 会被 0.1.7 的插件管理器拿去跟运行时比。 */
const isGated = (name: string) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

const peers = manifest.peerDependencies ?? {}
const gatedPeers = Object.entries(peers).filter(([name]) => isGated(name))

/** devDependencies 里 link 到上游 checkout 的那几个 dsh 包(= 我们真编译对着的那些)。 */
const linkedUpstream = Object.entries(manifest.devDependencies ?? {})
  .filter(([name, range]) => isGated(name) && range.startsWith('link:'))
  .map(([name]) => name)

function upstreamVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(require_.resolve(`${name}/package.json`), 'utf8')) as { version: string }
  return pkg.version
}

describe('peer 钉版(0.1.7 起插件管理器装前先查 peer)', () => {
  it('★九个 @deepseek-ai/dsh-* 包一个不落地都在 peer 里 —— 漏一个就漏一道门', () => {
    expect(linkedUpstream).toHaveLength(9)
    expect([...gatedPeers.map(([name]) => name)].sort()).toEqual([...linkedUpstream].sort())
  })

  it('★peer 写精确值,不写 ^ / ~ / >= —— includePrerelease 下 ^0.1.7 匹配不上 0.1.7-rc.2', () => {
    for (const [name, range] of gatedPeers) {
      expect(range, name).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    }
    expect(new Set(gatedPeers.map(([, range]) => range)).size).toBe(1)
  })

  it('★peer 的版本 = node_modules 里真指着的那一版上游(切了 tag 忘改 peer 就红)', () => {
    for (const [name, range] of gatedPeers) {
      expect(range, `${name} 的 peer 与 checkout 不一致`).toBe(upstreamVersion(name))
    }
  })

  it('cordis 不受那道门管(名字不是 dsh-*),但也跟着 checkout 对齐', () => {
    expect(isGated('@deepseek-ai/cordis')).toBe(false)
    expect(peers['@deepseek-ai/cordis']).toBe(upstreamVersion('@deepseek-ai/cordis'))
  })
})
