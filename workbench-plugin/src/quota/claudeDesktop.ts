/**
 * Claude 额度采集（拉取路）。
 *
 * 为什么会有这条路——原设计里 Claude 那一格由 Claude Code 的 statusLine **推**上来
 * （见 claude.ts），2026-08-20 实测推翻了它成立的前提：
 *
 * - Ben 这台机器上的 Claude Code 全部由桌面端拉起（`CLAUDE_CODE_ENTRYPOINT=claude-desktop`）。
 *   桌面端不渲染终端状态栏，因此**从不执行 statusLine 命令**——服务端起来之后的半小时里，
 *   会话一直在跑，`POST /statusline` 一条都没有进来过。`settings.json` 里的
 *   `refreshInterval: 30` 也因此从未触发。
 * - 此前 `~/.dsh/workbench/statusline.log` 里那些「带额度」痕迹全是 `pnpm test` 写的：
 *   测试跑真脚本却没有覆盖 `WORKBENCH_STATUSLINE_TRACE`，于是每跑一轮就往真日志里塞
 *   两行，和真实调用长得一模一样（已在 tests/server-statusline.test.ts 修掉）。
 *
 * 所以改成拉取，数据源取自 Claude 桌面端自己维护的用量记录：
 *
 * ```json
 * { "version": 2, "samples": [ { "t": 1787310289000, "org": "…", "u": { "fh": 88, "sd": 9 } } ] }
 * ```
 *
 * `fh` = 5 小时窗口已用百分比，`sd` = 周（all models）已用百分比。活跃时约每 15 分钟落一个
 * 样本，**空闲时会明显变稀**（实测出现过 40、45 分钟的间隔），所以这条路的新鲜度下限就是
 * 十几分钟——要实时只能靠 statusLine 那条推送。
 * 与 Ben 客户端截图逐条核对过：19:39 那条 `{fh:73, sd:8}` 对应界面「5h 已用 74% / 周 已用 8%」。
 *
 * 三条纪律，与本目录其余来源一致：
 * - 纯本地文件，只读。不读凭据、不发网络请求、不碰未公开接口。
 * - 只取两个百分比，`org` 等标识一概不带走——这份数据要推给展示台，展示台不该拿到账号标识。
 * - 形状不对就抛错标"未接入"，绝不猜一个数出来。
 *
 * 注意这份记录**没有重置时间**，两个窗口都只有百分比。statusLine 那条推送带 `resets_at`，
 * 数据更细，所以它仍然保留：终端里跑 CLI 时照样能覆盖上来（见 collect.ts 的取舍）。
 */
import type { QuotaWindow, WindowQuota } from '../protocol.ts'
import { claudeDesktopGoneNote } from '../protocol.ts'
import { windowFromUsedPercentage } from './claude.ts'

/** 样本里的窗口键 → 界面标签。顺序即展示顺序：短窗口在前，与 statusLine 那条保持一致。 */
const WINDOWS: readonly (readonly [string, string])[] = [
  ['fh', '5h'],
  ['sd', '周'],
]

/**
 * 记录默认位置。桌面端把它写在自己的 Application Support 下，路径里带空格，
 * 拼接时不要再手工加引号——调用方走的是 fs API，不过 shell。
 */
export function defaultClaudeDesktopUsageFile(home = process.env.HOME ?? ''): string {
  return `${home}/Library/Application Support/Claude/plan-usage-history.json`
}

/** 可注入的文件读取，测试用桩，绝不碰真实磁盘。 */
export interface ClaudeDesktopIo {
  readFile: (file: string) => Promise<string>
}

export interface ClaudeDesktopUsageOptions {
  /** 记录文件位置，缺省 defaultClaudeDesktopUsageFile()。 */
  file?: string
  io?: ClaudeDesktopIo
  /** 判断读数是否已过期的基准时刻。 */
  now?: Date
  /**
   * 最后一个样本超过这个岁数就判定为过期。
   *
   * 门槛原先定的 45 分钟（按"每 15 分钟一次、容得下漏采两次"算），实测太紧：
   * 桌面端**空闲时采样会明显变稀**，真机上抓到过 08:14→08:59 整整 45 分钟的间隔，
   * 正好顶在线上。而空闲恰恰是数字没在变的时候，这时判过期纯属自找麻烦——
   * 界面会无缘无故闪成"未接入"。
   *
   * 改成 2 小时。真正该标未接入的情形是**桌面端根本没在跑**，那是以小时计的。
   */
  maxAgeMs?: number
}

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000

interface UsageSample {
  t: number
  u: Record<string, unknown>
}

/** 从整份记录里挑出**最新**的一个样本。文件是追加写的，但不假设它一定有序。 */
function newestSample(payload: unknown): UsageSample {
  if (typeof payload !== 'object' || payload === null) throw new Error('Claude 桌面端用量记录不是对象')

  const samples = (payload as Record<string, unknown>).samples
  if (!Array.isArray(samples)) throw new Error('Claude 桌面端用量记录里没有 samples')

  let newest: UsageSample | undefined
  for (const raw of samples) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const t = record.t
    const u = record.u
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    if (typeof u !== 'object' || u === null) continue
    if (newest === undefined || t > newest.t) newest = { t, u: u as Record<string, unknown> }
  }

  if (newest === undefined) throw new Error('Claude 桌面端用量记录里没有可用样本')
  return newest
}

/**
 * 把最新样本翻成 WindowQuota。
 *
 * 两个窗口都读不出来就抛错，由调用方降级——只读出一个（比如桌面端换了字段名）也照样给，
 * 少一栏总比整格空掉强。
 */
export function parseClaudeDesktopUsage(payload: unknown, options: ClaudeDesktopUsageOptions = {}): WindowQuota {
  const sample = newestSample(payload)

  const now = (options.now ?? new Date()).getTime()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const ageMs = now - sample.t
  if (ageMs > maxAgeMs) {
    /**
     * 这句话会**原样出现在界面上**(/state.quota 那一格的 note,展示台与老四格都显示它),
     * 所以 2026-09-26(卡 QS)把它从「用量记录已过期」改成人话:「过期」「记录」是内部词,
     * 而且他要的意思是「Claude 桌面这会儿没在跑,读不到新的数」。
     * 与此同时:**读到过的数不因为这一下就翻成「没接上」** —— 那一层在 server/agentQuota.ts。
     *
     * ★ 2026-10-03 再改一次措辞(维护者:「Claude 额度格如实显示『Claude 桌面端没再提供』
     * 不再追」):句子在 `protocol.ts` 的 `claudeDesktopGoneNote` —— 界面层
     * (`client/quotaCells.ts`)要**认出这一种**好把大字从「未接入」换成实话,
     * 所以这句字只许有一份。岁数也从分钟改成小时(918 分钟前要她自己心算)。
     */
    throw new Error(claudeDesktopGoneNote(ageMs))
  }

  const windows: QuotaWindow[] = []
  for (const [key, label] of WINDOWS) {
    const used = sample.u[key]
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    windows.push(windowFromUsedPercentage(used, label))
  }

  if (windows.length === 0) throw new Error('Claude 桌面端用量记录的样本里没有可用窗口')

  /**
   * `as_of` 是**样本自己的时刻**,不是我们读文件的这一刻(2026-10-02,卡 QA)。
   *
   * 这条路读的本来就是十几分钟前落下的样本,拿「读到的那一刻」当截至时刻等于把它说新了 ——
   * 现场那一幕正是这么来的:04:27 那个样本在 21:3x 还被当成此刻的用量显示着。
   */
  return {
    kind: 'quota',
    windows,
    as_of: new Date(sample.t).toISOString(),
    source: CLAUDE_DESKTOP_SOURCE,
  }
}

/** 这个数哪来的(界面上「截至 04:27」旁边那半句)。 */
export const CLAUDE_DESKTOP_SOURCE = 'Claude 桌面端自己记的用量'

/** 读一次桌面端的用量记录。文件不存在、读不动、形状不对都抛错，由调用方降级。 */
export async function readClaudeDesktopUsage(options: ClaudeDesktopUsageOptions = {}): Promise<WindowQuota> {
  const file = options.file ?? defaultClaudeDesktopUsageFile()
  const io = options.io ?? {
    readFile: async (path: string) => {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8')
    },
  }

  let text: string
  try {
    text = await io.readFile(file)
  }
  catch {
    // 路径里带空格、又依赖桌面端在跑，读不到是常态而非异常。把话说清楚就够了。
    // 同上一条:这句话会原样上界面,所以说人话(卡 QS)。「没装或没跑过」这半句用例钉着,留着。
    throw new Error('读不到 Claude 桌面端报的用量(Claude 桌面端没装或没跑过)')
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  }
  catch {
    throw new Error('Claude 桌面端用量记录不是合法 JSON')
  }

  return parseClaudeDesktopUsage(payload, options)
}
