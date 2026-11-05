/**
 * 这份构建带着哪台中转、去哪查更新(2026-10-21,局域网 M7「零服务器是缺省」)。
 *
 * 源码里**不写**任何中转地址:构建时由这里定下来,经 tsdown 的 `define` 编进 `lib/index.js`(读法见 `src/buildEndpoints.ts`)。
 * 按顺序认:
 *
 * 1. 环境变量 `WORKBENCH_BUILD_RELAY_URL` / `WORKBENCH_BUILD_UPDATE_URL` —— **设了就算,设成空也算**,
 *    于是在内部仓里 `WORKBENCH_BUILD_RELAY_URL= WORKBENCH_BUILD_UPDATE_URL= pnpm build` 打出来的就是开源那一份;
 * 2. 仓库里的 `deploy/release-endpoints.env`(我们自己发版用的那一档)。**只在内部仓**:导出开发仓时剥掉
 *    (`docs/拆仓/导出开发仓.sh` 的 STRIP),所以开源仓库按 README 构建走不到这一步;
 * 3. 都没有 = 空:不连任何中转、不查更新。
 *
 * 同一份逻辑给三处用:`tsdown.config.ts`(插件与命令行)、`tsdown.kernel.config.ts`(安装器内核)、发版脚本
 * (`node scripts/build-endpoints.mjs` 打一行「这一份带着什么」,`--check <lib/index.js> [--only relay]` 核产物里编进去的是不是它)。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 环境变量名 → 编进产物的那个常量名。 */
export const BUILD_ENDPOINT_VARS = /** @type {const} */ ({
  WORKBENCH_BUILD_RELAY_URL: '__WORKBENCH_BUILD_RELAY_URL__',
  WORKBENCH_BUILD_UPDATE_URL: '__WORKBENCH_BUILD_UPDATE_URL__',
})

const here = dirname(fileURLToPath(import.meta.url))
export const RELEASE_PROFILE_FILE = join(here, '..', '..', 'deploy', 'release-endpoints.env')

/** `KEY=value` 一行一项,`#` 起头是注释;值两边的引号去掉(同 shell 的 `. 文件` 读法里最常见的那几种)。 */
export function parseProfile(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match === null) continue
    out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** 空,或 http(s) 地址(去掉末尾斜杠)。别的一律当打错了:宁可构建停下,也不要编进一个连不上的地址。 */
function checkedUrl(name, value) {
  const url = value.trim().replace(/\/+$/, '')
  if (url === '' || /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) return url
  throw new Error(`${name} 不是 http(s) 地址:${JSON.stringify(value)}`)
}

/**
 * @param {{ env?: Record<string, string | undefined>, profileFile?: string }} [options]
 * @returns {{ relay_url: string, update_manifest_url: string, from: 'env' | 'profile' | 'none' }}
 */
export function resolveBuildEndpoints(options = {}) {
  const env = options.env ?? process.env
  let profile
  try { profile = parseProfile(readFileSync(options.profileFile ?? RELEASE_PROFILE_FILE, 'utf8')) }
  catch { profile = undefined }
  const names = Object.keys(BUILD_ENDPOINT_VARS)
  const fromEnv = names.some(name => env[name] !== undefined)
  const pick = name => env[name] ?? (fromEnv ? '' : profile?.[name]) ?? ''
  return {
    relay_url: checkedUrl('WORKBENCH_BUILD_RELAY_URL', pick('WORKBENCH_BUILD_RELAY_URL')),
    update_manifest_url: checkedUrl('WORKBENCH_BUILD_UPDATE_URL', pick('WORKBENCH_BUILD_UPDATE_URL')),
    from: fromEnv ? 'env' : profile === undefined ? 'none' : 'profile',
  }
}

/** 给 tsdown `define` 的那几项(值是 JSON 字符串字面量)。 */
export function buildEndpointDefines(resolved = resolveBuildEndpoints()) {
  return {
    __WORKBENCH_BUILD_RELAY_URL__: JSON.stringify(resolved.relay_url),
    __WORKBENCH_BUILD_UPDATE_URL__: JSON.stringify(resolved.update_manifest_url),
  }
}

/** 发版脚本打的那一行。 */
export function describeBuildEndpoints(resolved) {
  const where = { env: '环境变量', profile: 'deploy/release-endpoints.env', none: '没有构建档 = 开源缺省' }[resolved.from]
  return `中转:${resolved.relay_url || '不带'} · 更新清单:${resolved.update_manifest_url || '不带'}(${where})`
}

/**
 * 产物里编进去的是不是这一份:两个地址都要原样出现;**不带**中转时产物的字符串里一个 `aibooo.cn` 地址都不许有
 * (开源那一份启动后不该有任何地方连我们的服务器)。只看引号里的字面量:注释与「官网 www.aibooo.cn」那句展示文字不算连接。
 * 回空数组 = 对得上。
 */
export function checkBuiltBundle(text, resolved, expect = ['relay', 'update']) {
  const problems = []
  for (const [kind, label, url] of [['relay', '中转', resolved.relay_url], ['update', '更新清单', resolved.update_manifest_url]]) {
    if (!expect.includes(kind)) continue
    if (url !== '' && !text.includes(JSON.stringify(url))) problems.push(`产物里没有编进${label}地址 ${url}`)
  }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (resolved.relay_url === '' && resolved.update_manifest_url === '' && /["'`][^"'`\n]*(?<!www\.)aibooo\.cn/.test(code)) {
    problems.push('不带中转的构建,产物里还有 aibooo.cn 的地址')
  }
  return problems
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const resolved = resolveBuildEndpoints()
  const at = process.argv.indexOf('--check')
  if (at === -1) {
    console.log(describeBuildEndpoints(resolved))
  }
  else {
    // `--check <文件> [--only relay]`:安装器内核用不到更新清单(打包时摇掉了),只核中转那一个。
    const file = process.argv[at + 1]
    const only = process.argv.indexOf('--only')
    const expect = only === -1 ? undefined : [process.argv[only + 1]]
    const problems = checkBuiltBundle(readFileSync(file, 'utf8'), resolved, expect)
    if (problems.length > 0) {
      console.error(problems.join('\n'))
      process.exit(1)
    }
    console.log(`${file}:${describeBuildEndpoints(resolved)},对得上`)
  }
}
