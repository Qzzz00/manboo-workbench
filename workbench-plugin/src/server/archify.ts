/**
 * Archify 产品图服务(2026-10-23,卡「图谱显示修复与Archify产品图接入」)。
 *
 * 负责 Archify 项目架构图与流程图的状态查询、规格读取(供 Agent 定向理解架构与验证源码)、
 * 静态交付物离线安全访问以及基于官方工具链的生成校验与原子落地。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync, statSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import type { ArchifyDiagramView, ArchifyStatusView } from '../protocol.ts'

/** desktop-workbench 官方收录并已验钉 c55 的五张架构图 */
export const DESKTOP_WORKBENCH_DIAGRAMS: readonly { id: string, name: string, type: string }[] = [
  { id: 'architecture-runtime', name: '运行时总览', type: 'architecture' },
  { id: 'tree-repo', name: '目录与模块树', type: 'tree' },
  { id: 'sequence-call', name: '提挂机与通话时序', type: 'sequence' },
  { id: 'sequence-video', name: '视频作者协作流程', type: 'sequence' },
  { id: 'lifecycle-card', name: '任务卡生命周期', type: 'lifecycle' },
]

export interface ArchifyAgentCliOptions {
  /** 已授权 Agent CLI 命令(默认 kimi,读 ~/.kimi 既有凭据,不走新账号) */
  command?: string
  /** 命令前置参数(默认 ['-p'],即 kimi 的非交互单提示模式) */
  args?: readonly string[]
  /** Agent 单次运行超时(默认 10 分钟) */
  timeoutMs?: number
}

export interface ArchifyServiceOptions {
  /** 用户数据主目录 (~/.dsh) */
  homeDir: string
  /** 仓库根目录(本仓兜底盘:无项目路径时的 --repo-root) */
  repoRoot: string
  /** 可选覆盖 archify CLI 路径 (默认 third_party/archify/bin/archify.mjs) */
  archifyBin?: string
  /** 项目 id → 本机路径(同 graphify 的 projectPaths;生成时按项目取证与定 --repo-root) */
  projectPaths?: () => Promise<readonly { id: string, path: string }[]>
  /** 「由 Agent 生成」用的已授权 CLI 配置 */
  agentCli?: ArchifyAgentCliOptions
}

export interface ArchifyService {
  status(projectId: string): Promise<ArchifyStatusView>
  readView(projectId: string, filename: string): Promise<{ found: boolean, content?: Buffer, contentType?: string, error?: string }>
  readSpec(projectId: string, diagramId: string): Promise<{ found: boolean, spec?: unknown, error?: string }>
  generate(projectId: string, diagramId: string, type: string, spec: unknown, opts?: { repoRoot?: string, quality?: string, /** 渲染专用副本(如去连线标签的兜底);落地规格仍写 spec 原件,连接名等语义不丢 */ specForRender?: unknown }): Promise<{ ok: boolean, error?: string, receipt?: unknown }>
  generateWithAgent(input: {
    projectId: string
    diagramId?: string
    type?: string
    projectPath?: string
  }): Promise<{ ok: boolean, error?: string, receipt?: unknown, diagramId?: string, agent?: string }>
}

const SAFE_ID_RE = /^[a-zA-Z0-9_\-]+$/
const SAFE_FILE_RE = /^[a-zA-Z0-9_\-.]+\.(html|json|svg)$/

/**
 * 官方渲染器没有自动布局(third_party grid.mjs 注释明说 "Not auto-layout — fixed cell
 * math only"):architecture 规格要么每个组件带 pos,要么带 grid row/col。Agent 手填坐标
 * 算术必错(实测:标签宽于框、重叠,全被官方布局校验打回),所以 Agent 一律不写坐标,
 * 由这里按连接拓扑做确定性分层:来源层=0,深度=最长前驱链(DFS 带环守护,回边按 0 计),
 * 同行按声明顺序排 col;组件宽度按标签字符数估算(CJK≈14px,ASCII≈7.2px,加边距)。
 */
function assignLayeredGrid(spec: unknown): void {
  const s = spec as {
    components?: { id?: unknown, label?: unknown, pos?: unknown, row?: unknown, col?: unknown, size?: unknown }[]
    connections?: { from?: unknown, to?: unknown }[]
    layout?: unknown
    meta?: unknown
  }
  const components = Array.isArray(s.components) ? s.components : []
  if (components.length === 0) return
  const anyPos = components.some(c => Array.isArray(c.pos) && c.pos.length === 2)
  if (anyPos) return // 有坐标就以坐标为准(混合缺坐标的交给官方校验如实判)

  const ids = new Set(components.map(c => String(c.id)))
  const predecessors = new Map<string, string[]>()
  for (const c of components) predecessors.set(String(c.id), [])
  for (const conn of (Array.isArray(s.connections) ? s.connections : [])) {
    const from = String(conn.from ?? '')
    const to = String(conn.to ?? '')
    if (from !== to && ids.has(from) && ids.has(to)) predecessors.get(to)!.push(from)
  }
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // 环:回边按 0 计,不无限加深
    visiting.add(id)
    let depth = 0
    for (const pred of predecessors.get(id) ?? []) {
      depth = Math.max(depth, depthOf(pred) + 1)
    }
    visiting.delete(id)
    memo.set(id, depth)
    return depth
  }

  const estLabelPx = (label: string): number => {
    let px = 0
    for (const ch of label) px += ch.codePointAt(0)! > 0x2E7F ? 14 : 7.2
    return px
  }
  const byRow = new Map<number, number>()
  let maxCols = 1
  let maxWidth = 120
  let maxRow = 0
  for (const c of components) {
    const id = String(c.id)
    const row = depthOf(id)
    const col = byRow.get(row) ?? 0
    byRow.set(row, col + 1)
    c.row = row
    c.col = col
    maxCols = Math.max(maxCols, col + 1)
    maxRow = Math.max(maxRow, row)
    const label = typeof c.label === 'string' ? c.label : id
    const width = Math.max(120, Math.min(280, Math.ceil(estLabelPx(label)) + 34))
    c.size = [width, 72]
    maxWidth = Math.max(maxWidth, width)
  }
  const cellW = maxWidth + 30
  const cellH = 96
  // 间距要能放下连线标签:横向 corridor 需容纳 ≤8 字标签(≈120px),纵向容纳 14px 标签 ± 偏移
  const gapX = 150
  const gapY = 72
  s.layout = { mode: 'grid', cols: maxCols, cellW, cellH, gapX, gapY }
  // 连线标签:默认压线中点,正贴在源/目标组件边上会被官方布局校验判重叠(实测)。
  // 按两端层级关系给确定性偏移:向下的线标签上移、向上的下移、同层居中 ——
  // 配合上面的宽 corridor,标签不再进任何组件的矩形。
  for (const conn of (Array.isArray(s.connections) ? s.connections : [])) {
    const c = conn as { from?: unknown, to?: unknown, labelDy?: unknown }
    if (c.labelDy !== undefined) continue
    const fromRow = depthOf(String(c.from ?? ''))
    const toRow = depthOf(String(c.to ?? ''))
    c.labelDy = toRow > fromRow ? -20 : toRow < fromRow ? 20 : 0
  }
  // 网格铺得比默认画布大时,官方构图检查会报 "extends outside the viewBox":
  // 按网格实际占地放大 viewBox(只在没有手工画布时)
  const meta = s.meta as Record<string, unknown>
  if (meta.viewBox === undefined) {
    meta.viewBox = [
      Math.max(700, 80 + maxCols * (cellW + gapX)),
      Math.max(240, 80 + (maxRow + 1) * (cellH + gapY) + 40),
    ]
  }
}

/**
 * 安装装配定位(2026-10-24 修独立审「安装态四候选全 MISSING」):
 * 产品装配(src/index.ts)编译成 lib/index.js 后,`new URL('../..', import.meta.url)`
 * 解析到的是**包的父目录**(@ben scope),不是包根 —— 传给 archify 的基准必须
 * 从装配模块的真实位置起算:
 *   - 编译形态:模块在 <包根>/lib/index.js → 基准 = 包根(随包资产在 <包根>/lib/…)
 *   - 源码检出形态:模块在 <仓库根>/workbench-plugin/src/index.ts → 基准 = 仓库根
 *     (third_party/ 与 docs/ 在仓库根;workbench-plugin/lib 已构建时也兼容)
 * 选中规则:第一个能让 archify 资产定位链命中的基准,找不到就退回包根(如实报错,不联网)。
 */
export function archifyAssetRootFrom(moduleUrl: string): string {
  const here = dirname(fileURLToPath(moduleUrl)) // lib/ 或 src/
  const packageRoot = dirname(here)              // 包根 或 workbench-plugin/
  const candidates = [packageRoot]
  if (basename(here) === 'src') {
    candidates.push(resolve(packageRoot, '..')) // 仓库检出:资产在仓库根(workbench-plugin 的上一级)
  }
  const hasAssets = (root: string): boolean =>
    existsSync(join(root, 'third_party', 'archify', 'bin', 'archify.mjs'))
    || existsSync(join(root, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs'))
  return candidates.find(hasAssets) ?? packageRoot
}

export function createArchifyService(options: ArchifyServiceOptions): ArchifyService {
  const { homeDir, repoRoot } = options
  const userArchifyDir = join(homeDir, '.dsh', 'workbench', 'archify')
  /**
   * 工具链与五图钉点产物的定位链(2026-10-24 修独立审「安装形态不可用」):
   * `npm pack` 只按 files 白名单打包,third_party/ 与 docs/ 在仓库根不进包。
   * 构建(copy-archify-assets.mjs)把它们拷进 lib/ 随包,所以运行时按序找:
   *   1. 仓库检出形态(repoRoot = 仓库根):third_party/archify、docs/全景地图/archify
   *   2. 安装/构建形态(repoRoot = 包根):lib/third_party/archify、lib/archify-pinned
   * 找不到就如实报「工具链未找到」,绝不联网下载。
   */
  const desktopDocsArchifyDir = [
    join(repoRoot, 'docs', '全景地图', 'archify'),
    join(repoRoot, 'lib', 'archify-pinned'),
  ].find(dir => existsSync(dir)) ?? join(repoRoot, 'docs', '全景地图', 'archify')
  const defaultBin = [
    join(repoRoot, 'third_party', 'archify', 'bin', 'archify.mjs'),
    join(repoRoot, 'lib', 'third_party', 'archify', 'bin', 'archify.mjs'),
  ].find(candidate => existsSync(candidate)) ?? join(repoRoot, 'third_party', 'archify', 'bin', 'archify.mjs')
  const archifyBin = options.archifyBin ?? defaultBin

  /** 获取项目的架构图产物所在目录 (优先 ~/.dsh/workbench/archify/<projectId>，desktop-workbench 缺省回退 docs/全景地图) */
  function getProjectDir(projectId: string): string | null {
    if (!SAFE_ID_RE.test(projectId)) return null
    const customDir = join(userArchifyDir, projectId)
    if (existsSync(customDir)) return customDir
    if (projectId === 'desktop-workbench' && existsSync(desktopDocsArchifyDir)) {
      return desktopDocsArchifyDir
    }
    return customDir
  }

  function getContentType(filename: string): string {
    if (filename.endsWith('.html')) return 'text/html; charset=utf-8'
    if (filename.endsWith('.json')) return 'application/json; charset=utf-8'
    if (filename.endsWith('.svg')) return 'image/svg+xml'
    return 'application/octet-stream'
  }

  /** 项目 id → 本机路径(解析失败/没有登记一律 undefined,由调用方决定兜底还是拒) */
  async function projectPathOf(projectId: string): Promise<string | undefined> {
    if (options.projectPaths === undefined) return undefined
    try {
      const anchors = await options.projectPaths()
      return anchors.find(anchor => anchor.id === projectId)?.path
    } catch {
      return undefined
    }
  }

  /** 文件修改时间(ms);拿不到(竞态删除等)返回 undefined,不编 */
  function mtimeOf(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  }

  /** 读规格的 meta(名称/类型/钉点都从规格里来,不在服务里写死第二份) */
  function readSpecMeta(projectDir: string, diagramId: string): { title?: string | undefined, type?: string | undefined, pin?: string | undefined } {
    try {
      const spec = JSON.parse(readFileSync(join(projectDir, `${diagramId}.json`), 'utf8')) as {
        diagram_type?: unknown
        meta?: { title?: unknown, repository?: { revision?: unknown } }
      }
      const title = typeof spec.meta?.title === 'string' ? spec.meta.title : undefined
      const type = typeof spec.diagram_type === 'string' ? spec.diagram_type : undefined
      const revision = typeof spec.meta?.repository?.revision === 'string' ? spec.meta.repository.revision : undefined
      return { title, type, pin: revision !== undefined ? revision.slice(0, 8) : undefined }
    } catch {
      return {}
    }
  }

  /**
   * realpath 越界校验(2026-10-23 独立审 Minor 3a:readView/readSpec 原来跟随符号链接,
   * 比 graphify 接缝弱一档):文件与目录都解真实路径,真实路径落在目录外一律拒。
   */
  function realpathEscapes(dir: string, filePath: string): boolean {
    try {
      const dirReal = realpathSync(dir)
      const fileReal = realpathSync(filePath)
      return fileReal !== join(dirReal, basename(fileReal)) && !fileReal.startsWith(dirReal + sep)
    } catch {
      // 解不出真实路径(悬空链等)按越界拒,不放行
      return true
    }
  }

  const impl: ArchifyService = {
    async status(projectId: string): Promise<ArchifyStatusView> {
      if (!SAFE_ID_RE.test(projectId)) {
        return { projectId, hasDiagrams: false, diagrams: [] }
      }

      // desktop-workbench 默认承接五张已验钉 c55 的全景图
      if (projectId === 'desktop-workbench') {
        const dir = getProjectDir(projectId)
        const diagrams: ArchifyDiagramView[] = []
        if (dir && existsSync(dir)) {
          for (const item of DESKTOP_WORKBENCH_DIAGRAMS) {
            const htmlPath = join(dir, `${item.id}.html`)
            const specPath = join(dir, `${item.id}.json`)
            if (existsSync(htmlPath)) {
              const meta = readSpecMeta(dir, item.id)
              diagrams.push({
                id: item.id,
                name: item.name,
                type: item.type,
                // 钉点从规格 meta.repository.revision 读,五图将来重钉不必改码
                ...(meta.pin !== undefined ? { pinnedCommit: meta.pin } : {}),
                // 生成时间 = 产物文件的真实修改时间
                ...(mtimeOf(htmlPath) !== undefined ? { generatedAt: mtimeOf(htmlPath) } : {}),
                hasHtml: true,
                hasSpec: existsSync(specPath),
              })
            }
          }
        }
        const firstPin = diagrams[0]?.pinnedCommit
        return {
          projectId,
          hasDiagrams: diagrams.length > 0,
          ...(firstPin !== undefined
            ? { pinnedCommit: firstPin, sourceNote: `钉点: ${firstPin} (desktop-workbench 运行时与生命周期等五图)` }
            : {}),
          diagrams,
          ...(diagrams[0]?.id !== undefined ? { selectedDiagramId: diagrams[0].id } : {}),
        }
      }

      // 其他项目(如 DouDou)：从自定义产物目录扫描，绝不串用 desktop-workbench
      const dir = join(userArchifyDir, projectId)
      if (!existsSync(dir)) {
        return { projectId, hasDiagrams: false, diagrams: [] }
      }

      try {
        const files = readdirSync(dir)
        const htmlFiles = files.filter(f => f.endsWith('.html'))
        const diagrams: ArchifyDiagramView[] = htmlFiles.map((f) => {
          const id = f.replace(/\.html$/, '')
          const hasSpec = existsSync(join(dir, `${id}.json`))
          const meta = hasSpec ? readSpecMeta(dir, id) : {}
          const mtime = mtimeOf(join(dir, f))
          return {
            id,
            // 名称/类型从规格的 meta 读(没有规格才退回 id / 'architecture')
            name: meta.title ?? id,
            type: meta.type ?? 'architecture',
            ...(mtime !== undefined ? { generatedAt: mtime } : {}),
            hasHtml: true,
            hasSpec,
          }
        })
        return {
          projectId,
          hasDiagrams: diagrams.length > 0,
          diagrams,
          ...(diagrams[0]?.id !== undefined ? { selectedDiagramId: diagrams[0].id } : {}),
        }
      } catch {
        return { projectId, hasDiagrams: false, diagrams: [] }
      }
    },

    async readView(projectId: string, filename: string): Promise<{ found: boolean, content?: Buffer, contentType?: string, error?: string }> {
      if (!SAFE_ID_RE.test(projectId) || !SAFE_FILE_RE.test(filename)) {
        return { found: false, error: '非法路径或文件名' }
      }
      if (filename.includes('..') || filename.includes('%2e%2e') || filename.startsWith('/') || filename.includes('\\')) {
        return { found: false, error: '禁止路径遍历' }
      }

      const dir = getProjectDir(projectId)
      if (!dir || !existsSync(dir)) {
        return { found: false, error: '项目架构图目录不存在' }
      }

      const filePath = resolve(dir, filename)
      // 防越界校验
      if (!filePath.startsWith(resolve(dir))) {
        return { found: false, error: '越出架构图访问根目录' }
      }
      if (!existsSync(filePath)) {
        return { found: false, error: '文件不存在' }
      }
      // 符号链接越界拒止:跟随链接后的真实路径必须仍落在项目目录内
      if (realpathEscapes(dir, filePath)) {
        return { found: false, error: '拒绝符号链接越出架构图目录的访问' }
      }

      try {
        const content = readFileSync(filePath)
        return {
          found: true,
          content,
          contentType: getContentType(filename),
        }
      } catch (err) {
        return { found: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async readSpec(projectId: string, diagramId: string): Promise<{ found: boolean, spec?: unknown, error?: string }> {
      if (!SAFE_ID_RE.test(projectId) || !SAFE_ID_RE.test(diagramId)) {
        return { found: false, error: '非法参数' }
      }

      const dir = getProjectDir(projectId)
      if (!dir || !existsSync(dir)) {
        return { found: false, error: '项目架构图目录不存在' }
      }

      const specPath = join(dir, `${diagramId}.json`)
      if (!existsSync(specPath)) {
        return { found: false, error: '规格文件不存在' }
      }
      // 符号链接越界拒止(同 readView)
      if (realpathEscapes(dir, specPath)) {
        return { found: false, error: '拒绝符号链接越出架构图目录的访问' }
      }

      try {
        const text = readFileSync(specPath, 'utf8')
        const spec = JSON.parse(text)
        return { found: true, spec }
      } catch (err) {
        return { found: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async generate(projectId: string, diagramId: string, type: string, spec: unknown, opts?: { repoRoot?: string, quality?: string, specForRender?: unknown }): Promise<{ ok: boolean, error?: string, receipt?: unknown }> {
      if (!SAFE_ID_RE.test(projectId) || !SAFE_ID_RE.test(diagramId) || !SAFE_ID_RE.test(type)) {
        return { ok: false, error: '非法参数' }
      }

      if (!existsSync(archifyBin)) {
        return { ok: false, error: `Archify 工具链未找到: ${archifyBin}` }
      }

      const projectDir = join(userArchifyDir, projectId)
      mkdirSync(projectDir, { recursive: true })

      const tempDir = join(projectDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(tempDir, { recursive: true })
      const tempSpecPath = join(tempDir, `${diagramId}.json`)
      const tempHtmlPath = join(tempDir, `${diagramId}.html`)

      // --repo-root 按项目解析:显式传入 → 项目登记路径 → 本仓兜底。
      // 不能一律本仓(独立审 Minor 3b):给 DouDou 生的图带本仓 evidence,图与项目对不上。
      const effectiveRepoRoot = opts?.repoRoot ?? (await projectPathOf(projectId)) ?? repoRoot
      const quality = opts?.quality ?? 'showcase'

      // 渲染输入可以是副本(兜底去标签),但**落地规格必须是原件** —— 规格 JSON 是
      // 连接名等唯一语义的存档,渲染为过校验绝不许悄悄删它(2026-10-24 语义门)。
      const renderSpec = opts?.specForRender ?? spec

      try {
        writeFileSync(tempSpecPath, JSON.stringify(renderSpec, null, 2), 'utf8')

        // 步骤 1：先使用 deliver / validate 检查规格并生成 HTML
        const result = spawnSync('node', [
          archifyBin,
          'deliver',
          type,
          tempSpecPath,
          tempHtmlPath,
          '--quality',
          quality,
          '--repo-root',
          effectiveRepoRoot,
          '--json',
        ], { encoding: 'utf8' })

        if (result.status !== 0) {
          const errOutput = result.stderr || result.stdout || '生成失败'
          // stdout 是收据 JSON 时,抽出 error 与第一条诊断,路径噪音不带进人话
          let concise = errOutput.slice(0, 1200)
          try {
            const receipt = JSON.parse(result.stdout) as { error?: string, diagnostics?: { message?: string }[] }
            if (typeof receipt.error === 'string') {
              concise = receipt.diagnostics?.[0]?.message !== undefined
                ? `${receipt.error.split('\n')[0]};${receipt.diagnostics[0].message}`
                : receipt.error.slice(0, 1200)
            }
          } catch {
            // stdout 不是 JSON 就带原文
          }
          return { ok: false, error: `Archify 校验失败 (exit ${result.status}): ${concise}` }
        }

        let receipt: unknown = null
        try {
          receipt = JSON.parse(result.stdout)
        } catch {
          // stdout 不是纯 json 也没关系
        }

        // 验证产物合法
        if (!existsSync(tempHtmlPath) || readFileSync(tempHtmlPath, 'utf8').length < 100) {
          return { ok: false, error: '生成的 HTML 产物为空或无效' }
        }

        // 步骤 2：原子落地至项目目录(失败走到这里之前旧文件原样未动)。
        // 规格落原件(render 副本只喂渲染),HTML 落渲染产物。
        const targetSpecPath = join(projectDir, `${diagramId}.json`)
        const targetHtmlPath = join(projectDir, `${diagramId}.html`)
        writeFileSync(targetSpecPath, JSON.stringify(spec, null, 2), 'utf8')
        copyFileSync(tempHtmlPath, targetHtmlPath)

        return { ok: true, receipt }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true })
        }
      }
    },

    async generateWithAgent(input) {
      const { projectId } = input
      if (!SAFE_ID_RE.test(projectId)) {
        return { ok: false, error: '非法参数' }
      }
      // 五图是钉点收录的官方产物,不在这条「Agent 现场生成」路上覆盖
      if (projectId === 'desktop-workbench') {
        return { ok: false, error: 'desktop-workbench 五图是钉点收录产物,不由 Agent 覆盖生成' }
      }
      const diagramId = input.diagramId ?? `${projectId}-arch`
      const type = input.type ?? 'architecture'
      if (!SAFE_ID_RE.test(diagramId) || !SAFE_ID_RE.test(type)) {
        return { ok: false, error: '非法参数' }
      }

      // Agent 取证范围 = 该项目自己的目录(用户个人项目只读);登记不到路径就如实拒
      const projectPath = input.projectPath ?? (await projectPathOf(projectId))
      if (projectPath === undefined || !existsSync(projectPath)) {
        return { ok: false, error: `找不到项目 ${projectId} 的本机路径,Agent 无法取证` }
      }

      const cli = options.agentCli?.command ?? 'kimi'
      const cliArgs = [...(options.agentCli?.args ?? ['-p'])]
      const timeoutMs = options.agentCli?.timeoutMs ?? 600_000

      const projectDir = join(userArchifyDir, projectId)
      mkdirSync(projectDir, { recursive: true })
      const agentSpecPath = join(projectDir, `.agent-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

      const prompt = [
        '你是只读取证的架构分析 Agent,为 Archify 产品图产出一份 JSON-IR 架构规格。',
        `项目目录:${projectPath}(只读;除第 3 条的输出文件外,不许写任何文件)。`,
        `输出:schema_version=1、diagram_type="architecture"、meta.title="<项目中文名> · 架构图"、meta.output="${diagramId}.html"、meta.quality_profile="showcase"、meta.locale="zh-CN",以及 components[] 与 connections[]。`,
        '硬约束(官方 schema 会校验,不满足整份作废):',
        '1) components[].type 只允许这 7 个值:frontend / backend / database / cloud / security / messagebus / external —— 按角色选最接近的,不许自造;',
        '2) components[] 每个必须有 id(小写英文短横线)、label(中文名)、type;sources 是对象数组、最多 3 条:[{"path":"项目内相对路径","line":行数}],不许写字符串路径;',
        '3) connections[] 的 from/to 必须引用已声明的组件 id,label ≤ 8 个中文字(长句会被官方构图检查打回);',
        '4) components 必须来自项目里真实存在的模块/进程/页面,connections 必须是真实的调用或数据关系,不许编造;规模 8~20 个,覆盖主要分层;',
        '5) 不要写 pos / size / row / col —— 布局由官方渲染器自动排版,手填坐标反而要过布局校验(标签长度超出框宽会直接作废);',
        '形状示例(字段名照此,内容换成你读到的真实结构;meta.repository 不用你写,服务端会补项目 git 信息):{"schema_version":1,"diagram_type":"architecture","meta":{"title":"<项目中文名> · 架构图","output":"' + diagramId + '.html","quality_profile":"standard","locale":"zh-CN"},"components":[{"id":"mac-client","label":"Mac 客户端","type":"frontend","sources":[{"path":"src/main.ts","line":12}]}],"connections":[{"from":"mac-client","to":"core","label":"调用"}]}',
        '6) 只输出:把这份 JSON 用写文件工具写进环境变量 ARCHIFY_SPEC_OUT 指定的路径,JSON 之外不要包解释文字;',
        '7) 写完后回复不超过 5 行中文:你读了哪些文件、图里画了什么。',
      ].join('\n')

      /**
       * 跑一轮 Agent:提示词进去,规格文件出来。
       * 必须异步 spawn(不能用 spawnSync):本服务跑在工作台服务进程里,spawnSync 会
       * 把整个事件循环卡住几分钟——期间 8791 所有页面请求全部无响应。Agent 跑多久,
       * 别的请求就该正常服务多久。
       */
      const runAgentOnce = (extraDirective: string): Promise<{ ok: true, spec: unknown } | { ok: false, error: string }> => {
        return new Promise((resolve) => {
          const child = spawn(cli, [...cliArgs, extraDirective === '' ? prompt : `${prompt}\n\n${extraDirective}`], {
            cwd: projectPath,
            env: { ...process.env, ARCHIFY_SPEC_OUT: agentSpecPath },
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
          const killer = setTimeout(() => { child.kill('SIGTERM') }, timeoutMs)
          child.once('error', (err) => {
            clearTimeout(killer)
            resolve({ ok: false, error: `Agent 启动失败:${err.message}` })
          })
          child.once('close', (code) => {
            clearTimeout(killer)
            if (code !== 0) {
              const timedOut = code === null
              resolve({ ok: false, error: timedOut ? `Agent 运行超时(>${Math.floor(timeoutMs / 1000)}s),已保留原有可用版` : `Agent 运行失败(exit ${code}):${(stderr || stdout).trim().slice(-300)}` })
              return
            }
            if (!existsSync(agentSpecPath)) {
              resolve({ ok: false, error: 'Agent 没有写出规格文件,已保留原有可用版' })
              return
            }
            try {
              resolve({ ok: true, spec: JSON.parse(readFileSync(agentSpecPath, 'utf8')) })
            } catch {
              resolve({ ok: false, error: 'Agent 写出的规格不是合法 JSON,已保留原有可用版' })
            }
          })
        })
      }

      /** 形状 + repository 补钉 + 分层布局;返回可交付的规格,或 null(error 带人话)。 */
      const prepareSpecOf = (spec: unknown): { ok: true, spec: unknown } | { ok: false, error: string } => {
        const shape = spec as { schema_version?: unknown, diagram_type?: unknown, meta?: unknown }
        if (typeof shape.schema_version !== 'number' || typeof shape.diagram_type !== 'string' || typeof shape.meta !== 'object' || shape.meta === null) {
          return { ok: false, error: 'Agent 写出的规格缺少必要字段(schema_version/diagram_type/meta)' }
        }
        assignLayeredGrid(spec)
        // 现场生成的图走 standard 档:showcase 的桌面可读性构图门对自动分层布局过于苛刻
        // (实测同一拓扑有时 9/9 过、有时卡在 composition/desktop-readability),生成失败率
        // 不该由运气决定。质量档如实写进规格 meta。
        const meta = shape.meta as Record<string, unknown>
        meta.quality_profile = 'standard'
        // meta.repository 由服务端补真值(官方校验带 --repo-root 时必填):项目 git HEAD
        // 与 origin 地址。Agent 现场猜会编,本地的真值只有本机知道。
        const specMeta = shape.meta as Record<string, unknown>
        if (specMeta.repository === undefined) {
          const rev = spawnSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
          const remote = spawnSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim()
          if (!/^[0-9a-f]{40}$/i.test(rev) || remote === '') {
            return { ok: false, error: `项目 ${projectId} 没有可用的 git 仓库信息(需要 HEAD 提交与 origin 远端);官方工具链要求 meta.repository 是可链接的仓库地址,未生成、保留原有可用版` }
          }
          specMeta.repository = {
            url: remote,
            revision: rev,
            ...(remote.includes('github.com') ? { provider: 'github' } : {}),
            link_mode: 'local-only',
          }
        }
        return { ok: true, spec }
      }

      try {
        // 第一轮:原始提示词。规格不过官方校验时,把校验诊断回喂 Agent 修一轮(只修一轮,
        // 不修就如实失败)——现场产规格对 schema 很敏感,一次性成功率不该由运气决定。
        const first = await runAgentOnce('')
        if (first.ok === false) {
          return { ok: false, error: `${first.error},已保留原有可用版`, diagramId, agent: cli }
        }
        let prepared = prepareSpecOf(first.spec)
        if (prepared.ok === false) {
          return { ok: false, error: `${prepared.error},已保留原有可用版`, diagramId, agent: cli }
        }
        /**
         * 交付,带布局兜底:连线标签的位置校验(标签压组件)随拓扑变化,固定一个 labelDy
         * 不可能稳过。失败后按确定性候选(官方离线校验当裁判)逐个试;最后兜底是
         * 去掉连线 label 交付(拓扑与组件仍全,连接名丢失——比整张图交付失败好,
         * 且质量档/事实都如实)。generate 失败不写盘,试错无副作用。
         */
        const deliverWithLayoutFallback = async (spec: unknown): Promise<{ ok: boolean, error?: string, receipt?: unknown }> => {
          const variants: { labelDy?: number, stripLabels?: boolean }[] = [
            {},
            { labelDy: 24 }, { labelDy: -24 }, { labelDy: 48 }, { labelDy: -48 }, { labelDy: 16 }, { labelDy: -16 }, { labelDy: 0 },
            { stripLabels: true },
          ]
          let last = ''
          for (const variant of variants) {
            const trial = JSON.parse(JSON.stringify(spec)) as { connections?: (Record<string, unknown>)[] }
            if (Array.isArray(trial.connections)) {
              for (const conn of trial.connections) {
                if (variant.stripLabels === true) { delete conn.label; continue }
                if (variant.labelDy !== undefined) conn.labelDy = variant.labelDy
              }
            }
            const attempt = await impl.generate(projectId, diagramId, type, spec, { repoRoot: projectPath, quality: 'standard', specForRender: trial })
            if (attempt.ok) return attempt
            last = attempt.error ?? '未知原因'
            // 只有布局/构图类失败值得换标签重试;schema 类错误换标签无意义,直接返回
            if (!/layout|overlaps|composition|label/i.test(last)) return attempt
          }
          return { ok: false, error: last }
        }

        let delivered = await deliverWithLayoutFallback(prepared.spec)
        if (!delivered.ok) {
          const why = (delivered.error ?? '未知原因').slice(0, 800)
          const repair = await runAgentOnce(`你上次写的规格没有通过官方校验,诊断如下。请修正规格后**重新写入同一个文件**(覆盖旧内容),只改不合规处,不要改结构:\n${why}`)
          if (repair.ok === false) {
            return { ok: false, error: `Agent 规格未通过官方校验:${why};修复轮:${repair.error};已保留原有可用版`, diagramId, agent: cli }
          }
          prepared = prepareSpecOf(repair.spec)
          if (prepared.ok === false) {
            return { ok: false, error: `Agent 规格未通过官方校验:${why};修复轮:${prepared.error};已保留原有可用版`, diagramId, agent: cli }
          }
          delivered = await deliverWithLayoutFallback(prepared.spec)
          if (!delivered.ok) {
            const why2 = (delivered.error ?? '未知原因').slice(0, 800)
            return { ok: false, error: `Agent 规格两轮均未通过官方校验(第二轮:${why2});已保留原有可用版`, diagramId, agent: cli }
          }
        }
        return { ok: true, receipt: delivered.receipt, diagramId, agent: cli }
      } finally {
        if (existsSync(agentSpecPath)) {
          rmSync(agentSpecPath, { force: true })
        }
      }
    },
  }
  return impl
}
