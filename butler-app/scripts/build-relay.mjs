/**
 * 手机包带着哪台中转(2026-10-21,局域网 M7「零服务器是缺省」)。读法与电脑端 `workbench-plugin/scripts/build-endpoints.mjs`
 * 同一条规矩(两边各自一份,顶层子目录互不 import):
 *
 * 1. 环境变量 `WORKBENCH_BUILD_RELAY_URL` —— 设了就算,设成空也算;
 * 2. 内部仓的 `deploy/release-endpoints.env`(导出开发仓时剥掉);
 * 3. 都没有 = 空:这份手机包没接中转,登录入口不出现(卡 M4 读 `DEFAULT_RELAY_URL === ''`)。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const RELEASE_PROFILE_FILE = join(here, '..', '..', 'deploy', 'release-endpoints.env')

/** `KEY=value` 一行一项里取 `WORKBENCH_BUILD_RELAY_URL`;引号去掉。 */
function fromProfile(text) {
  for (const raw of text.split('\n')) {
    const match = /^\s*(?:export\s+)?WORKBENCH_BUILD_RELAY_URL=(.*)$/.exec(raw)
    if (match !== null) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

/** @returns {string} 空,或去掉末尾斜杠的 http(s) 地址。写错了就抛,构建停下。 */
export function relayUrlForBuild(env = process.env, profileFile = RELEASE_PROFILE_FILE) {
  let value = env.WORKBENCH_BUILD_RELAY_URL
  if (value === undefined && env.WORKBENCH_BUILD_UPDATE_URL === undefined) {
    try { value = fromProfile(readFileSync(profileFile, 'utf8')) }
    catch { value = undefined }
  }
  const url = (value ?? '').trim().replace(/\/+$/, '')
  if (url === '' || /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) return url
  throw new Error(`WORKBENCH_BUILD_RELAY_URL 不是 http(s) 地址:${JSON.stringify(value)}`)
}
