/**
 * 发到用户机器上的那几份脚本是哪几份(2026-09-25,卡 R 补)。
 *
 * 清单只写在发版脚本里:热更新是 `deploy/publish-update.sh` 里打 scripts.tgz 的那条 `tar`,
 * 安装包是 `deploy/build-installer.sh` 里那几条 `cp "$REPO_ROOT/…"`。这里**照着那两处读**,不另抄一份 ——
 * 以后谁往那两处加一份脚本,守门用例(package-files-guard)与热更新真跑用例(update-dsh-start-e2e)
 * 自动把它算进去;读不出来(发版脚本改了写法)就回空数组,用例会因为"一份都没读到"当场红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根(desktop-workbench/)。这个文件在 workbench-plugin/tests/helpers/ 下。 */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

/** 热更新 scripts.tgz 带的文件(仓库相对路径),按 publish-update.sh 里那条 tar 的顺序。 */
export function updateScriptFiles(): string[] {
  const lines = readFileSync(join(REPO_ROOT, 'deploy', 'publish-update.sh'), 'utf8').split('\n')
  const start = lines.findIndex(line => line.includes('tar -czf "$STAGE/scripts.tgz"'))
  if (start < 0) return []
  const out: string[] = []
  let index = start
  // 那条 tar 是用行尾反斜杠续行写的:一直读到不再续行的那一行为止。
  while ((lines[index] ?? '').trimEnd().endsWith('\\')) {
    index += 1
    const line = (lines[index] ?? '').trim().replace(/\\$/, '').trim()
    for (const token of line.split(/\s+/)) {
      if (token !== '') out.push(token)
    }
  }
  return out
}

/** 安装包里带的文件(仓库相对路径):build-installer.sh 里 `cp "$REPO_ROOT/…" "$PAYLOAD/…"`(或 `$STAGE/…`)那几条。 */
export function installerScriptFiles(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'deploy', 'build-installer.sh'), 'utf8')
  const out: string[] = []
  for (const match of text.matchAll(/cp\s+"\$REPO_ROOT\/([^"]+)"\s+"\$(?:PAYLOAD|STAGE)\//g)) {
    if (match[1] !== undefined && !out.includes(match[1])) out.push(match[1])
  }
  return out
}
