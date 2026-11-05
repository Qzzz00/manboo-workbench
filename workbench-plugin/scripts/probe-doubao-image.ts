/**
 * 真机核一眼:豆包刚出的那张图,进没进它的本机缓存、工作台挑不挑得出来(2026-10-12,演示彩排第 0 步)。
 * **只读**:不写、不删缓存里任何东西;挑出来的那张另存到暂存目录给人看。
 *
 *   node workbench-plugin/scripts/probe-doubao-image.ts [最近几分钟,缺省 10] [另存到哪个目录,缺省不存]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverDoubaoCacheDirs, findDoubaoImage } from '../src/server/doubaoImage.ts'

const minutes = Number(process.argv[2] ?? '10')
const out = process.argv[3]
const since = Date.now() - minutes * 60_000
const dirs = await discoverDoubaoCacheDirs()
const got = await findDoubaoImage({ cacheDirs: dirs, since })
if (got === undefined) {
  console.log(`最近 ${minutes} 分钟里,豆包缓存里没挑出够大的新图(查过:${dirs.length === 0 ? '一个豆包缓存目录都没找到' : dirs.join(' / ')})`)
  process.exit(1)
}
console.log(`挑到了:${got.info.width}×${got.info.height} ${got.info.mime},${got.body.length} 字节,${new Date(got.mtimeMs).toLocaleString()}`)
console.log(`网址:${got.url.replace(/\?.*$/, '?…')}`)
if (out !== undefined) {
  const file = join(out, `doubao-probe.${got.info.ext}`)
  writeFileSync(file, got.body)
  console.log(`另存到:${file}`)
}
