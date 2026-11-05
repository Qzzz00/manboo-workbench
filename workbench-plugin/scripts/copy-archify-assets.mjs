/**
 * 把 Archify 官方离线工具链与五张钉点产物拷进 `lib/`(2026-10-24,卡「图谱显示修复与Archify接入」)。
 *
 * 为什么:`npm pack` 按 package.json 的 files 白名单打包,`third_party/` 与 `docs/` 在仓库根、
 * 不进包 —— 安装形态(独立审固定 Major)下 `generate/status` 一律「工具链未找到/五图不存在」。
 * 沿用起步层/技能资产「产物随包」的既有模式:构建期拷进 lib,files 白名单带上,
 * 运行时按包内路径解析(见 server/archify.ts 的解析链)。版本仍 pin(third_party 里就是官方 3.2.0
 * 逐字节收录),不新外连,许可/归属事实不变(MIT,tt-a1i/Archify + Cocoon AI)。
 *
 * 五图是钉点收录产物(c55ff4c1,生成于 17e573970):这里**逐字节拷贝**、不重画不重钉;
 * status/readView/readSpec 从包内这份读,内容与工作台仓库 docs 里那份是同一份。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const repoRoot = join(pluginDir, '..')

const archifyFrom = join(repoRoot, 'third_party', 'archify')
const archifyTo = join(pluginDir, 'lib', 'third_party', 'archify')
rmSync(archifyTo, { recursive: true, force: true })
if (existsSync(archifyFrom)) {
  cpSync(archifyFrom, archifyTo, { recursive: true, filter: src => !src.split('/').pop().startsWith('.') })
}

// 五图钉点产物:只带运行时要的 html + json(view/spec 两条路各读一份;delivery 收据与 receipts/ 留在仓库)
const pinnedFrom = join(repoRoot, 'docs', '全景地图', 'archify')
const pinnedTo = join(pluginDir, 'lib', 'archify-pinned')
rmSync(pinnedTo, { recursive: true, force: true })
if (existsSync(pinnedFrom)) {
  mkdirSync(pinnedTo, { recursive: true })
  for (const name of readdirSync(pinnedFrom)) {
    if (/\.(html|json)$/.test(name) && !name.endsWith('.delivery.json')) {
      cpSync(join(pinnedFrom, name), join(pinnedTo, name))
    }
  }
}
console.log(existsSync(archifyFrom) ? `Archify 工具链 → ${archifyTo}` : `没有 ${archifyFrom},lib/third_party 留空`)
console.log(existsSync(pinnedFrom) ? `五图钉点产物 → ${pinnedTo}` : `没有 ${pinnedFrom},lib/archify-pinned 留空`)
