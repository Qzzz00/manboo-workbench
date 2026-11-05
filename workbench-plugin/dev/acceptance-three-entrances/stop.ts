/**
 * 收掉 `run.ts --keep` 留下的隔离实例(或上一次跑到一半断了的):撤中转上这台的设备、退出测试账号、
 * 停 DSH / 语音后端 / 工人、删临时 HOME。只认传进来的那个临时目录。
 *
 *   node dev/acceptance-three-entrances/stop.ts <run.ts 打印的临时目录>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stopRoot } from './instance.ts'

const root = process.argv[2]
if (root === undefined || !existsSync(join(root, 'iso'))) {
  console.error('用法:node dev/acceptance-three-entrances/stop.ts <临时目录>(里面要有 iso/)')
  process.exit(2)
}
let saved: { phoneId: string, workerPidFile: string } | undefined
try { saved = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8')) as { phoneId: string, workerPidFile: string } } catch { saved = undefined }
await stopRoot(root, line => console.log(line), saved)
