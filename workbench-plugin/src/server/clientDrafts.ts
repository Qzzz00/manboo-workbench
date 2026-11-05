/**
 * 他在某家 Agent 客户端输入框里**没发出去的那段字**,派活要覆盖它之前先存在这里。
 * (2026-09-27,卡 DB;现场见 `docs/交接-0927-豆包派活先开新对话.md`)
 *
 * 21:23 那一通电话:「找豆包,把这几天我跟他聊的内容总结一下」。窗口那只手回的是
 * 「没送:com.bot.pc.doubao 的输入框里有你没发出去的字,覆盖掉就找不回来了」——
 * 一个字都没送出去。维护者的规矩:**不许静默覆盖,但也不许因为它就把活停下**。
 * 所以:壳把那段原文读出来(`send_text` 的 `save_draft`),这里落盘存住,送完壳再原样放回框里;
 * 放不回去时(没替他按发送、发完框里还有字、框被换掉了)就只存着,并在事项上告诉他存哪了。
 *
 * 落盘规格与仓库里别的几份一致:`~/.dsh/workbench/drafts/`,一段草稿一个文件,**原文原样**
 * (不是 JSON,不转义、不 trim —— 放回去要逐字一样,而他可能就是要那个换行)。
 * 旁边一份 `.json` 记这段字是哪一家、哪一刻、为哪件事让位的 —— 内容与出处分开两个文件,
 * 是为了「原文原样」这一条不被 JSON 的编解码碰到。
 *
 * **不清理、不过期**:他没发出去的话是他的东西,工作台没有替他删的道理(维护者删得动,我们不动)。
 */
import { mkdir, writeFile } from 'node:fs/promises'

/** 存一段草稿要知道的事实。 */
export interface ClientDraftSave {
  /** 哪一家(`doubao` / `kimi` …)。 */
  family: string
  /** 框里读回来的原文,**原样**。 */
  text: string
  /** 让位的时刻(ISO)。 */
  at: string
  /** 为哪件事让的位(事项 id)。没有就不写。 */
  taskId?: string
}

/** 存好之后的结果。`ok:false` 时 `reason` 是原话 —— 存不下来就该在卡上说存不下来,不假装存了。 */
export interface ClientDraftSaved {
  ok: boolean
  /** 存哪了(绝对路径)。存不下来时缺席。 */
  path?: string
  reason?: string
}

/**
 * ★ **空框时读回来的那句占位符,不是草稿**(2026-10-13,卡 F;四场景验收第 15 条)。
 *
 * 真机上存下来的那份「草稿」内容是「发消息或按住空格说话...」—— 豆包**空框**时 `AXValue`
 * 读回来的就是这句占位符。壳里那张表(`SendTextPolicy.knownPlaceholders`)只列了 Manus,
 * 而**壳不随插件发版**,所以这一道补在插件侧:存了它的后果是草稿目录里多一份假草稿,
 * 卡上 / 手机上 / 电话里还多说一句不实的话(「你没发出去的那句我存在这里了」)。
 *
 * 只列**真机上读到过的**那几句;认不准的宁可当草稿存着(存错一份比丢掉她半句话轻)。
 */
export const CLIENT_INPUT_PLACEHOLDERS: readonly string[] = [
  // 豆包(三个包都是同一句;2026-09-24 读出来的占位符,10-13 真机又撞上一次)。
  '发消息或按住空格说话...',
]

/**
 * 壳交回来的「框里原有的字」其实是空框的占位符吗。
 * 省略号三个点与单字符「…」算同一句(两种写法真机上都读到过),前后空白不算。
 */
export function isClientInputPlaceholder(text: string): boolean {
  // 末尾那几个点(`...` / `．．．` / `…`)归一成一个「…」;句号不动(她真写的半句可能就以句号收)。
  const key = (one: string): string => one.trim().replace(/[.．…]+$/u, '…')
  const got = key(text)
  return got !== '…' && CLIENT_INPUT_PLACEHOLDERS.some(one => key(one) === got)
}

/** 草稿都放这个目录(`~/.dsh/workbench/drafts/`)。 */
export function draftsDir(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/drafts`
}

/**
 * 一段草稿的文件名:`<家>-<时刻>.txt`。
 *
 * 时刻里的 `:` 与 `.` 换成 `-`(文件名里带冒号在 Finder 里显示成斜杠,他自己去翻这个目录时会看不懂)。
 * 家名与时刻都**只留** `[0-9a-zA-Z_-]`:这两个值都是从我们自己的枚举与 `Date` 来的,
 * 但文件名是路径,一律先洗一遍,免得哪天换了来源就能写到别的目录去。
 */
export function draftFileName(family: string, at: string): string {
  const safe = (one: string): string => one.replace(/[^0-9a-zA-Z_-]/g, '-')
  return `${safe(family)}-${safe(at)}.txt`
}

export function draftFilePath(family: string, at: string, home = process.env.HOME ?? ''): string {
  return `${draftsDir(home)}/${draftFileName(family, at)}`
}

/**
 * 卡上那一句人话:「你没发的那句我存在这里了」。
 *
 * 两档,**说的是同一件事的两个结果**:
 * - 放回去了 → 只说存了一份、已经放回;他回到那家看见的还是自己那半句。
 * - 没放回去 → 说清存在哪个文件、为什么没放回(壳的原话原样带走,D13)。
 *
 * 没存下来(`ok:false`)那一档不在这里 —— 那时根本不该送,失败那条路上的人话由
 * `dispatchClient.humanizeFailure` 出,这里不另写一套。
 */
export function draftSavedNote(input: { who: string, saved: ClientDraftSaved, returned: boolean, reason?: string }): string {
  const who = input.who
  if (!input.saved.ok) {
    return `${who}的输入框里有你没发出去的字,我没能把它存下来(${input.saved.reason ?? '没说原因'})`
  }
  const where = input.saved.path ?? '工作台的草稿目录'
  if (input.returned) {
    return `你在${who}输入框里没发出去的那句,我先存了一份(${where}),送完已经原样放回框里了`
  }
  const why = input.reason === undefined || input.reason.trim() === '' ? '' : `:${input.reason}`
  return `你在${who}输入框里没发出去的那句我存在这里了:${where} —— 这次没能放回框里${why}`
}

/**
 * 真落盘的那一半(碰文件系统的只有这一个函数)。**绝不抛** —— 存不下来是一句话,不是把派活带塌。
 */
export async function saveClientDraft(input: ClientDraftSave, home = process.env.HOME ?? ''): Promise<ClientDraftSaved> {
  const path = draftFilePath(input.family, input.at, home)
  try {
    await mkdir(draftsDir(home), { recursive: true })
    // 原文原样:不 JSON、不 trim、不加尾换行 —— 放回去要逐字一样。
    await writeFile(path, input.text, 'utf8')
    await writeFile(`${path}.json`, `${JSON.stringify({
      version: 1,
      family: input.family,
      at: input.at,
      ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
      chars: input.text.length,
    }, null, 2)}\n`, 'utf8')
    return { ok: true, path }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
