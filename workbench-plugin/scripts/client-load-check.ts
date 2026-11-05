/**
 * 「网页端能加载」的命令行外壳(2026-10-22)。判法在 `scripts/clientLoadCheck.ts`。
 *
 *     node workbench-plugin/scripts/client-load-check.ts --tgz <plugin.tgz>   # 本机闸、新机器演练用这一条
 *     node workbench-plugin/scripts/client-load-check.ts --file <lib/client.js>
 *
 * `--tgz` 从包里直接读 `package/lib/client.js` —— 就是 DSH 页面要装的那几个字节。
 * 退出码:0 能加载;2 不能(下面一行说为什么);1 参数不对 / 读不出来。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { checkClientBundle } from './clientLoadCheck.ts'

const argv = process.argv.slice(2)
const flag = argv[0]
const target = argv[1]
if ((flag !== '--tgz' && flag !== '--file') || target === undefined || argv.length !== 2) {
  process.stderr.write('用法:client-load-check.ts --tgz <plugin.tgz> | --file <client.js>\n')
  process.exit(1)
}

let code: string
try {
  code = flag === '--tgz'
    ? execFileSync('tar', ['-xzOf', target, 'package/lib/client.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(target, 'utf8')
}
catch {
  process.stderr.write(`读不出客户端产物(${flag === '--tgz' ? `${target} 里的 package/lib/client.js` : target})\n`)
  process.exit(1)
}

const result = checkClientBundle(code)
if (result.ok) {
  process.stdout.write(`网页端能加载:注册上了 ${result.slots.join('、')}\n`)
  process.exit(0)
}
process.stdout.write(`网页端加载不了:${result.error ?? '(没说为什么)'}\n`)
for (const line of result.stack ?? []) process.stdout.write(`    ${line}\n`)
process.exit(2)
