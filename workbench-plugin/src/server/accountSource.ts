/**
 * 账号数据源(2026-09-21)—— 运营模板下项目区那一格读的就是它。
 *
 * 一个账号 = 工作目录下 `账号/<账号名>/` 一个文件夹。文件的读写在 `accounts.ts`,
 * 这里只负责把它摊成 `ProjectSource` 那三个方法。
 *
 * ## 「没配工作目录」是一条错,不是一片空白
 *
 * `butler_cwd` 缺席时不猜路径、不建目录(同 templateStore.makeFolders 那条规矩),
 * 但**如实回一条 scan_error**:项目区上面会出现一行「未接入:还没配工作目录…」。
 * 静悄悄地回一个空列表的后果是界面显示「还没有账号」—— 那是假话,真相是"不知道去哪儿找"。
 *
 * ## 数字从哪来、哪些数字故意没有
 *
 * - 笔记条数与最近一条的日期:数 `笔记/` 里的文件(见 accounts.readAccountNotes);
 * - 进行中事项数:**问看板要**(`openTasks`)。没接看板就整个字段缺席,**不填 0** ——
 *   「一件都没有」和「数不出来」不许长成同一个 0(D13);
 * - 粉丝数 / 曝光 / 涨粉这类平台数据:**一个都没有**。工作台不上网,也不猜。
 *   那是「数据复盘」那一格的事,接数据是另一张卡。
 */
import { join } from 'node:path'
import type { AccountSignals, ProjectDetailLine } from '../protocol.ts'
import { ACCOUNT_FIELDS, ACCOUNTS_DIR_NAME, accountsDir, listAccountNames, readAccountFile, readAccountNotes } from './accounts.ts'
import type { ProjectSource, ProjectSourceListing, ProjectSummary } from './projectSource.ts'

export interface AccountSourceOptions {
  /**
   * 工作目录(butler_cwd)。**每次扫描现问一遍**(同 gitSource 的 scanRoots):
   * 起服务时取一次的话,Ben 在设置里配完工作目录要重启才看得见账号。
   * 没配就回 undefined / 空串 —— 不猜一个路径。
   */
  workdir: () => string | undefined
  /**
   * 每个账号名下还没做完的事项数。不接就整块缺席(**不是 0**)。
   * 键是**项目 id**,由合并层按账号文件夹路径推出来(见 projectsService.pickRepoId),
   * 所以这里拿到的 map 也得按 id 索引。
   */
  openTasks?: () => Promise<ReadonlyMap<string, number>>
  /** 当前 Unix 秒。`idle_days` 按它算。 */
  now: () => number
}

/** `YYYY-MM-DD` → 那天 00:00(本地)的 Unix 秒。解析不了回 undefined(**不猜**)。 */
function dayStartSec(dateOnly: string): number | undefined {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)
  if (matched === null) return undefined
  const at = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
  return Number.isNaN(at) ? undefined : Math.floor(at / 1000)
}

export function createAccountSource(opts: AccountSourceOptions): ProjectSource {
  /**
   * 事项数这一份每轮扫描只问一次(而不是每个账号问一次)—— 看板是整份读盘的,
   * 一个账号问一次的话 10 个账号就把同一个文件读 10 遍。
   * 一轮里 list() 先跑、summary() 后跑,所以在 list() 里刷新,summary() 直接用。
   */
  let openTasks: ReadonlyMap<string, number> | undefined

  return {
    id: 'accounts',
    // 账号文件夹里不会有人开编码会话:跑一遍归属的结果是把这台机器上所有会话
    // 都聚成「待归档」挂在账号列表下面,在运营机器上那是纯噪音(见 projectSource.ts 头注)。
    attributes_sessions: false,

    async list(): Promise<ProjectSourceListing> {
      openTasks = opts.openTasks === undefined ? undefined : await opts.openTasks().catch(() => undefined)
      const cwd = opts.workdir()
      if (cwd === undefined || cwd === '') {
        return {
          paths: [],
          scan_errors: [{
            root: ACCOUNTS_DIR_NAME,
            reason: '还没配工作目录,不知道去哪儿找账号文件夹(设置 → 目录 → 工作目录)',
          }],
        }
      }
      const dir = accountsDir(cwd)
      const names = await listAccountNames(dir)
      return { paths: names.map(name => join(dir, name)), scan_errors: [] }
    },

    async summary(path: string, id: string): Promise<ProjectSummary> {
      let fields: Record<string, string | undefined>
      let notes: { count: number, lastAt?: string }
      try {
        fields = await readAccountFile(path)
        notes = await readAccountNotes(path)
      }
      catch (error) {
        return {
          kind: 'error',
          error: `账号文件夹读不动:${error instanceof Error ? error.message : String(error)}`,
          idle_candidate: false,
        }
      }
      const lastAt = notes.lastAt
      const lastSec = lastAt === undefined ? undefined : dayStartSec(lastAt)
      const account: AccountSignals = {
        note_count: notes.count,
        ...(fields.平台 === undefined ? {} : { platform: fields.平台 }),
        ...(lastAt === undefined ? {} : { last_note_at: lastAt }),
        ...(fields.开号日期 === undefined ? {} : { opened_at: fields.开号日期 }),
        ...(lastSec === undefined ? {} : { idle_days: Math.max(0, Math.floor((opts.now() - lastSec) / 86400)) }),
        // 按**项目 id** 去问,不是按账号名:id 是合并层消歧过的(两个同名账号不会串)。
        ...(openTasks === undefined ? {} : { open_tasks: openTasks.get(id) ?? 0 }),
      }
      return {
        kind: 'account',
        account,
        // 「最近一次活动」= 最近那条笔记**那天的本地零点**(不是 UTC 零点 —— 两者在 +08:00 差 8 小时,
        // 而「状态过期」比的就是这个时刻与人写状态的时刻)。算不出日期就整块缺席。
        ...(lastSec === undefined ? {} : { last_activity_at: new Date(lastSec * 1000).toISOString() }),
        // 账号**永远不进闲置线**。理由见 projectSource.ProjectSummaryBase.idle_candidate:
        // 刚被引导建出来、一条笔记都没有的账号折进一行灰字,等于问完就把它藏了。
        idle_candidate: false,
      }
    },

    /**
     * 这里**又读了一遍 `账号.md`**(summary 刚读过)。一个账号两次小文件读,没有做缓存:
     * 缓存要有人负责作废(人手改了 `账号.md` 之后下一拍就该变),而一份 markdown 的读
     * 比作废逻辑写错便宜得多。账号数量级是"个位数到几十",不是几百。
     */
    async detail(path: string): Promise<readonly ProjectDetailLine[]> {
      const fields = await readAccountFile(path)
      // 顺序就是 ACCOUNT_FIELDS 的顺序(= 文件里那几行的顺序),**没写的那几项不出现**:
      // 摆一行「定位:—」看起来像"他说过、只是没内容"。
      return ACCOUNT_FIELDS
        .filter(field => fields[field] !== undefined)
        .map(field => ({ label: field, text: fields[field] as string }))
    },
  }
}
