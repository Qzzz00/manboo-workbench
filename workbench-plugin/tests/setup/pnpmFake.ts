/**
 * 假的「自带 pnpm」(2026-09-27,卡 PN)。
 *
 * 装插件那一步从这一版起先把自带的 pnpm 放到位(`install.ts` 的 `ensurePnpm`) ——
 * 三条纪律与 node 那一步一样:核 sha256、解包、装完当场跑一次。用假 io 跑那几步的用例
 * 因此要能回答三个问题,而这三个答案只该有**一处**定义:
 *
 *   ① `shasum -a 256 <pnpm 的 tgz>` → 仓库里钉着的那一份;
 *   ② `tar -xzf … -C <dshHome>/pnpm` → 真把入口文件摆出来(不然"跑一次"那一关永远过不去);
 *   ③ `<dshHome>/node/bin/pnpm --version` → 钉死的那一版。
 *
 * 这几样都是「假装装上了」,不是「跳过检查」—— 检查本身(顺序、路径、版本)照样在跑。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SetupExecResult } from '../../src/server/setup/io.ts'
import type { SetupPaths } from '../../src/server/setup/paths.ts'
import { LOCKED_PNPM_VERSION, PNPM_TARBALL_NAME, PNPM_TARBALL_SHA256 } from '../../src/server/setup/paths.ts'

/** 安装包 payload 里那份 pnpm 的 .tgz(build-installer.sh 收进去的位置)。 */
export function seedBundledPnpm(payloadRoot: string): string {
  const tgz = join(payloadRoot, 'pnpm', PNPM_TARBALL_NAME)
  mkdirSync(dirname(tgz), { recursive: true })
  writeFileSync(tgz, 'fake-pnpm-tgz')
  return tgz
}

/**
 * `~/.dsh/node/bin/npm`:node 那一步从这一版起要求它在(不在就下官方独立包 —— 只复制一条
 * node 二进制的那条路不带 npm,而下一步的 `npm ci` 就是靠它)。
 */
export function seedOwnNpm(paths: SetupPaths): void {
  const bin = join(paths.nodeDir, 'bin', 'npm')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
}

/**
 * 「这台机器上自带的 pnpm 已经装好了」:真写两个文件,`ensurePnpm` 探一次就直接跳过。
 *
 * 用真 io / 真 exec 的那几份用例(热更新 e2e)用它 —— 不然那一步会真去 npmmirror 下 9MB。
 * 这也正是真机上的常态:装过一次之后,以后每次热更新那一段都是"已经在了,不用装"。
 */
export function seedInstalledPnpm(paths: SetupPaths): void {
  mkdirSync(dirname(paths.pnpmEntry), { recursive: true })
  writeFileSync(paths.pnpmEntry, '// fake pnpm')
  mkdirSync(dirname(paths.pnpmBin), { recursive: true })
  writeFileSync(paths.pnpmBin, `#!/bin/sh\necho ${LOCKED_PNPM_VERSION}\n`, { mode: 0o755 })
}

/** 这三条命令由假 io 照上面那三条回答;别的命令回 undefined(交回原来的查表逻辑)。 */
export function fakePnpmExec(paths: SetupPaths, cmd: readonly string[]): SetupExecResult | undefined {
  if (cmd[0] === 'shasum' && (cmd.at(-1) ?? '').endsWith(PNPM_TARBALL_NAME)) {
    return { ok: true, code: 0, out: `${PNPM_TARBALL_SHA256}  ${cmd.at(-1) ?? ''}\n` }
  }
  if (cmd[0] === 'tar' && cmd.includes(paths.pnpmDir)) {
    mkdirSync(dirname(paths.pnpmEntry), { recursive: true })
    writeFileSync(paths.pnpmEntry, '// fake pnpm')
    return { ok: true, code: 0, out: '' }
  }
  if (cmd[0] === paths.pnpmBin) return { ok: true, code: 0, out: `${LOCKED_PNPM_VERSION}\n` }
  return undefined
}
