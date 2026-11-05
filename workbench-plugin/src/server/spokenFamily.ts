/**
 * 「他嘴里那一家」到底是哪一家 —— **插件侧那一份**(2026-09-28,卡 FX)。
 *
 * ## 撞出来的事
 *
 * 2026-09-28 早统筹在维护者本机实测 `GET /sessions/lookup?who=`(本机 4 条会话:codex 1、claude 3):
 *
 * | 他说的 | 当时答的 | 该答的 |
 * |---|---|---|
 * | `Codex` | codex 那条「整理 Sportlight…」 ✓ | 同 |
 * | `Kimi` | **claude** 的「Fix flaky client-dock.test.tsx…」✗ | 「Kimi 这会儿没有在跑的对话」 |
 * | `minus` | **claude** 那条 ✗ | 先认成 Manus，再说 Manus 没有在跑的对话 |
 * | `Manus` / `豆包` | 「没认出他说的是哪一条会话(这会儿有 4 条)」✗ | 「X 这会儿没有在跑的对话」 |
 *
 * 病根:`matchRelaySession` 是**一池子会话一起打分**的 —— 家名只值 15 分,标题的二元组
 * 撞上两个就 20 分。于是「Kimi」在 Kimi 没有会话时,被 claude 那条标题里的碎片赢了过去。
 * **点了名的那一家,就绝不该答别家的对话。**
 *
 * ## 这一份做什么
 *
 * 只回答一句话:**他那句原话点的是哪一家**。纯函数、不经模型、判据与
 * `channel-worker/src/agentName.ts` 的 {@link import('../../../channel-worker/src/agentName.ts')}
 * 是**同一套的两份实现**(顶层子目录互不 import,仓库结构那一条)——
 * 两边各有用例,`tests/lookup-family-first.test.ts` 与 `channel-worker/tests/agent-name.test.ts`
 * 用**同一组输入**钉住两端认出来的是同一家。改判据要两边一起改。
 *
 * | 对上什么 | 分 |
 * |---|---|
 * | 名字原样在他那句话里(`manus`、`豆包`) | 100 |
 * | 辅音骨架相同(`minus`→`mns`=`manus`) | 60 |
 * | 编辑距离 ≤ 1 | 60 |
 * | 编辑距离 ≤ 2 且名字有 5 个字母以上 | 40 |
 * | 中文:他说的是名字的头两个字(`豆包`↔`豆包办公`) | 60 |
 *
 * ## 候选只取本机真装的那几家(卡 HC 的规矩)
 *
 * {@link spokenFamilies} 的候选是 `/state.installed_agents` 探到的那几家 ——
 * 没装的家不该被认出来(认出来只会得到一句「它没有在跑的对话」,而他根本没提它)。
 * **探不到那一格时**(Spotlight 关了 / 老宿主)退回知识表里那几家:
 * 「查不到」不许冒充「没有」(D13)。此刻有会话的那几家永远在候选里 ——
 * 有会话就是装着的最硬证据(`gpt` 这种连 App 都没有的也靠这条进来)。
 */
import { DISPATCH_FAMILY_TITLES } from '../protocol.ts'

/** 一家的正名与他可能怎么念它。`id` 是登记表里的家名(与会话的 `agent` 同一套)。 */
export interface SpokenFamily {
  id: string
  /** 念给他听用这个名字。 */
  title: string
  /** 他还会怎么说它。**不含正名**(正名自动算一条)。 */
  aliases?: readonly string[]
}

/**
 * 他还会怎么念这几家:中文译名与常见的听错写法,按家名挂。
 *
 * **这一份是主人**:电话工人那份 `channel-worker/src/agentName.ts` 的 `FALLBACK_FAMILIES`
 * 必须与这张表(加上 {@link DISPATCH_FAMILY_TITLES} 的正名)逐条相同 ——
 * 由 `channel-worker/tests/agent-name-sync.test.ts` **直接读这个文件**比对,漂了就红。
 * (2851e0b0 把 GPT/ChatGPT 认成 Codex 时只改了这一份,工人那份漂了两天,
 * 电话里说「让 ChatGPT 写」两头认成两家 —— 从此不再靠「逐字相同」这句注释。)
 *
 * **只写他真会念出来的** —— 辅音骨架那一条已经覆盖了绝大多数听错
 * (`minus` / `menus` / `manas` 全都 → `mns` = `manus`),不需要一张错拼清单。
 */
export const FAMILY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ['克劳德'],
  // 2026-09-30 Air 真机:ChatGPT 桌面版就是 Codex 那个 App(com.openai.codex),他嘴里叫「GPT」「ChatGPT」。
  // 「只走接口」的那一家 GPT 自己的正名照旧是 GPT;两家都在时点名「GPT」会问一句是哪一个。
  codex: ['ChatGPT', 'GPT', 'Chat GPT'],
  doubao: ['豆包', '豆包工作', 'Doubao'],
  muse: ['缪斯'],
  manus: ['马纳斯'],
}

export type SpokenMatch =
  /** 唯一高置信:**直接当这一家,不问**。 */
  | { kind: 'one', id: string, title: string }
  /** 两家都像:问一句「是 A 还是 B?」。 */
  | { kind: 'many', families: readonly SpokenFamily[], line: string }
  /** 一家都不像。 */
  | { kind: 'none' }

/** 认字用的归一化:小写、去空白与常见标点。中文原样留着。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[,,。.、;;::!!??「」『』"'""''()()【】[\]<>《》~~—\-_/\\|]+/g, '')
}

/** 他那句话里的一个词:`word` 是认字用的小写形,`raw` 是他原话里那一截。 */
export interface SpokenWord { word: string, raw: string }

/**
 * 他那句话里的词:连续的拉丁字母/数字算一个,连续的中日韩字算一个,
 * **外加相邻两个拉丁词拼起来的那一个** —— ASR 常把一个名字断成两截(「mu si」= Muse)。
 */
export function spokenWords(text: string): readonly SpokenWord[] {
  const out: SpokenWord[] = []
  const runs: { word: string, raw: string, at: number, latin: boolean }[] = []
  const re = /[A-Za-z0-9]+|[㐀-鿿]+/g
  let hit: RegExpExecArray | null = re.exec(text)
  while (hit !== null) {
    const raw = hit[0]
    runs.push({ word: raw.toLowerCase(), raw, at: hit.index, latin: /^[A-Za-z0-9]+$/.test(raw) })
    hit = re.exec(text)
  }
  for (const run of runs) out.push({ word: run.word, raw: run.raw })
  for (let i = 0; i + 1 < runs.length; i += 1) {
    const a = runs[i] as { word: string, raw: string, at: number, latin: boolean }
    const b = runs[i + 1] as { word: string, raw: string, at: number, latin: boolean }
    if (!a.latin || !b.latin) continue
    // 中间只隔空白才算同一个名字被断开(「mu si」算,「mu,发给 si」不算)。
    const between = text.slice(a.at + a.raw.length, b.at)
    if (!/^[\s　]*$/.test(between)) continue
    out.push({ word: `${a.word}${b.word}`, raw: text.slice(a.at, b.at + b.raw.length) })
  }
  return out
}

/**
 * 辅音骨架:首字母留着,后面去掉元音,再把连着的同一个字母并成一个。
 * `minus`→`mns`、`manus`→`mns`、`muse`→`ms`、`claude`→`cld`、`codex`→`cdx`。
 * **两个字母以下的骨架不算命中**(太容易误撞)。
 */
export function consonantKey(word: string): string {
  const letters = word.toLowerCase().replace(/[^a-z]/g, '')
  if (letters === '') return ''
  const first = letters[0] as string
  const rest = letters.slice(1).replace(/[aeiou]/g, '')
  let out = first
  for (const ch of rest) if (ch !== out[out.length - 1]) out += ch
  return out
}

/** 编辑距离(Levenshtein)。只用来比两个短词,没做优化。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = row
  }
  return prev[b.length] ?? Math.max(a.length, b.length)
}

/** 一个名字对上他那句话得几分。**0 = 没对上**。 */
export function spokenScore(said: string, name: string): number {
  const needle = normalize(name)
  if (needle.length < 2) return 0
  const asked = normalize(said)
  if (asked.includes(needle)) return 100
  const latin = /^[a-z0-9]+$/.test(needle)
  let best = 0
  for (const { word } of spokenWords(said)) {
    if (word.length < 2) continue
    if (latin) {
      if (!/^[a-z0-9]+$/.test(word)) continue
      const key = consonantKey(needle)
      if (key.length >= 2 && consonantKey(word) === key) best = Math.max(best, 60)
      const distance = editDistance(word, needle)
      if (distance <= 1) best = Math.max(best, 60)
      else if (distance <= 2 && needle.length >= 5) best = Math.max(best, 40)
      continue
    }
    // 中文:他只说了名字的头两个字(「豆包」↔「豆包办公」),或者名字整个在他那个词里。
    if (word.length >= 2 && needle.startsWith(word)) best = Math.max(best, 60)
  }
  return best
}

/** 够格算「像这一家」的最低分。与工人那份同一个数。 */
export const SPOKEN_MIN_SCORE = 40

/**
 * 他这句话里点的是哪一家。**唯一高置信就直接当那一家,不问**;并列两家才问一句。
 */
export function matchSpokenFamily(said: string, families: readonly SpokenFamily[]): SpokenMatch {
  if (said.trim() === '' || families.length === 0) return { kind: 'none' }
  const scored = families.map((family) => {
    const names = [family.title, ...(family.aliases ?? []), family.id]
    return { family, score: Math.max(...names.map(name => spokenScore(said, name))) }
  })
  const best = Math.max(...scored.map(one => one.score))
  if (best < SPOKEN_MIN_SCORE) return { kind: 'none' }
  const top = scored.filter(one => one.score === best).map(one => one.family)
  const first = top[0]
  if (top.length === 1 && first !== undefined) return { kind: 'one', id: first.id, title: first.title }
  return { kind: 'many', families: top, line: `是${top.map(one => one.title).join('还是')}?` }
}

/**
 * 他那句话里**除了家名之外**还剩什么(2026-09-28,卡 FX)。
 *
 * 为什么要这一刀:家名认完之后,剩下那半句才是「在这一家里挑哪一条」的依据。
 * 不切掉的话,家名本身的字母会去撞会话标题的二元组 ——
 * 真机上「Claude」里的 `cl` / `la` 撞上了「Fix f**la**ky **cl**ient-dock…」,
 * 白得 20 分,于是「只说了家名」被当成「点了那一条」。
 *
 * 切两刀:名字原样出现的整段全去掉;名字是听错的(`minus`)就去掉得分最高的那一截。
 */
export function stripSpokenFamily(said: string, family: SpokenFamily): string {
  const names = [family.title, ...(family.aliases ?? []), family.id].filter(one => one.trim() !== '')
  let out = said
  for (const name of names) {
    out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
  }
  let best = 0
  let target: string | undefined
  for (const { word, raw } of spokenWords(out)) {
    const score = Math.max(...names.map(name => spokenScore(word, name)))
    if (score >= SPOKEN_MIN_SCORE && score > best) { best = score; target = raw }
  }
  return target === undefined ? out : out.replace(target, ' ')
}

/** 探到装了的一家:`/state.installed_agents` 里那几格要的两样。 */
export interface InstalledFamilyLike { id: string, name: string }

/**
 * 认家名的候选表:**本机真装的那几家 + 此刻有会话的那几家**。
 *
 * - `installed` 缺席(还没探过 / 探不出来)→ 退回知识表 `DISPATCH_FAMILY_TITLES` 那几家(D13);
 * - `agents` 是此刻会话表里出现过的家名:有会话就是装着的最硬证据,永远在候选里
 *   (`gpt` 这种连 App 都没有的靠这条进来)。
 * - 家名的显示名优先用探测/知识表里的那个;都没有就原样用 id(包标识也照样能被念对一次)。
 */
export function spokenFamilies(input: {
  installed?: readonly InstalledFamilyLike[] | undefined
  /** 此刻会话表里的家名(去重前也行)。 */
  agents?: readonly string[] | undefined
}): readonly SpokenFamily[] {
  const titles = new Map<string, string>()
  const base = input.installed === undefined || input.installed.length === 0
    ? Object.entries(DISPATCH_FAMILY_TITLES).map(([id, name]) => ({ id, name }))
    : input.installed
  for (const one of base) {
    if (one.id === 'dsh' || one.id.trim() === '') continue
    titles.set(one.id, one.name.trim() === '' ? one.id : one.name)
  }
  for (const agent of input.agents ?? []) {
    if (agent === 'dsh' || agent.trim() === '' || titles.has(agent)) continue
    titles.set(agent, DISPATCH_FAMILY_TITLES[agent] ?? agent)
  }
  return [...titles].map(([id, title]) => {
    const aliases = FAMILY_ALIASES[id]
    return aliases === undefined ? { id, title } : { id, title, aliases }
  })
}
