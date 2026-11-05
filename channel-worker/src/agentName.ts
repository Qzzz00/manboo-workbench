/**
 * 「他嘴里那一家」到底是哪一家(2026-09-27,卡 MS)。
 *
 * 维护者 21:17 在电话里说:「给 minus 发个信息问他国庆节中国法定节日是放几天」。
 * ASR 听成的是 `minus`,他说的是本机装着的 **Manus**。那一通里事务官回的是
 * 「没认出『minus』是哪条会话。这会儿开着三条:Kimi…Codex…Claude…——你说的是哪一条?」
 * 维护者:「你在讲什么?哪有那么复杂?」
 *
 * 病根不是模型笨,是**没有一处代码在做读音近似**:名字要么一字不差对上,要么当没认出来。
 * 电话里过 ASR 的名字几乎永远不是一字不差的。
 *
 * 这个文件就是那一处。**纯函数、不经模型**:
 *   - {@link matchSpokenFamily}:他那句话里点的是哪一家。唯一高置信 → 直接当那一家,**不问**;
 *     两家都像 → 回 `many`,由模型问一句「是 Manus 还是 Muse?」;一家都不像 → `none`。
 *   - {@link canonicalWho}:把他那句话里那个听错的名字**换成登记表里的正名**再送给工作台
 *     (`/sessions/relay` 那头认会话靠家名,送「minus」过去它一样认不出)。
 *
 * 判据(逐条写明,验收时看得见靠什么认出来的):
 * | 对上什么 | 分 |
 * |---|---|
 * | 名字原样在他那句话里(`manus`、`豆包`) | 100 |
 * | 他那句话里某个词与名字**辅音骨架相同**(`minus`→`mns`=`manus`;`mu si`→`ms`=`muse`) | 60 |
 * | 编辑距离 ≤ 1 | 60 |
 * | 编辑距离 ≤ 2 且名字有 5 个字母以上 | 40 |
 * | 中文:他说的是名字的头两个字(`豆包`↔`豆包办公`) | 60 |
 *
 * 与 workbench-plugin 的 `server/spokenFamily.ts` 是**同一套判据的两份实现**(两边不互相 import,
 * 仓库结构那一条)。改判据要**两边一起改**:别名表那一份由 `tests/agent-name-sync.test.ts`
 * 直接读插件源码比对(漂了就红),判分那几个函数只有两边各自的用例钉着。
 *
 * ★ **候选池不是两份了**(2026-10-03,卡「两条接缝」):从前 `matchSpokenFamily` 的候选缺省是
 * 下面那张写死的知识表,于是「电脑上认得出、电话里认不出」(运行时发现的那几家)。现在
 * **主人是插件的家族目录**,从 `GET /families` 拉({@link applyFamilyPool}),
 * 拉不到才用 {@link FALLBACK_FAMILIES}。判据(打分那几个函数)仍是两份实现 —— 那一半没动。
 *
 * ★ **什么时候拉**(2026-10-03,卡 C):**每次进房前**(`main.ts`)**与每通电话开始时**
 * (`agent.ts` 的 `refreshSelfBrief`)各一次。只有前一次时,工人常驻在房里 ——
 * 她启动之后新装的那一家要等断房重连才认得出(审计材料 2026-10-03 附证 C)。
 */

/** 一家的正名与他可能怎么念它。`id` 是派活用的家名(与 8791 的 TaskAssignee 同一套)。 */
export interface SpokenFamily {
  id: string
  /** 登记表里的显示名(念给他听用这个)。 */
  title: string
  /** 他还会怎么说它。**不含正名**(正名自动算一条)。 */
  aliases?: readonly string[]
}

/**
 * ★ **兜底那一份 —— 只在拉不到主人那一份时用**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦)。
 *
 * **主人是工作台插件的家族目录**:`workbench-plugin/src/server/agentSources.ts` 的 `FAMILY_SOURCES`
 * +(正名)`protocol.ts` 的 `DISPATCH_FAMILY_TITLES` +(别名)`server/spokenFamily.ts` 的
 * `FAMILY_ALIASES`,由 `GET /families` 下发({@link setFamilyPool})。工人启动时每轮拉一份;
 * **拉到了就一律用那一份**,这张表一个字都不参与。
 *
 * 为什么还留着它:工作台刚重启 / 这份工作台是旧版(没有 `/families`)时,电话已经进房了 ——
 * 那时候「一家都认不出」比「认得出写过专门接法的那几家」糟。所以它是**主人那份的子集**,
 * 由 `tests/agent-name-sync.test.ts` 直接读插件源码钉着(⊆,漂了就红)。
 *
 * 它比主人那份少什么:少**运行时发现的那几家**(Grok Bot、Antigravity ——
 * 它们的家名就是包标识,知识表里压根没有)。所以拉不到时电话里点名「Grok Bot」认不出,
 * 那是如实的「这会儿问不到工作台」,不是猜一家顶上。
 *
 * 别名只写**他真会念出来的**:中文译名与常见的听错写法。写死一个"错拼清单"不是目的 ——
 * 辅音骨架那一条已经覆盖了绝大多数听错(`minus`/`menus`/`manas` 全部 → `mns`)。
 */
export const FALLBACK_FAMILIES: readonly SpokenFamily[] = [
  // 2026-09-30 Air 真机:ChatGPT 桌面版就是 Codex 那个 App(com.openai.codex),他嘴里叫「GPT」「ChatGPT」。
  // 「只走接口」的那一家 GPT 自己的正名照旧是 GPT;两家都在时点名「GPT」会问一句是哪一个。
  { id: 'codex', title: 'Codex', aliases: ['ChatGPT', 'GPT', 'Chat GPT'] },
  { id: 'claude', title: 'Claude', aliases: ['克劳德'] },
  { id: 'kimi', title: 'Kimi' },
  { id: 'gpt', title: 'GPT' },
  { id: 'doubao', title: '豆包办公', aliases: ['豆包', '豆包工作', 'Doubao'] },
  { id: 'muse', title: 'Muse', aliases: ['缪斯'] },
  { id: 'manus', title: 'Manus', aliases: ['马纳斯'] },
]

/**
 * 主人下发的那一份(`GET /families`)。`undefined` = 这一轮还没拉到 → 用 {@link FALLBACK_FAMILIES}。
 *
 * 为什么是模块级的一格而不是层层传参:认家名的调用点有十来处(`tools.ts` 里八处、`butlerRoute.ts`
 * 一处),它们都在模型的工具回调里,没有一条能顺手拿到工作台客户端。**一处写、一处读**,
 * 换成传参会在每个调用点留一次「忘了传就悄悄退回兜底」的机会。
 */
let downstreamFamilies: readonly SpokenFamily[] | undefined

/**
 * 主人那一份下来了。**整池换掉**;传 `undefined` / 空数组 = 退回兜底(不是「一家都没有」)。
 *
 * 形状容错:8791 回包里哪一行缺 `id` / `title` 就丢那一行 —— 一行坏了不许把整池清空。
 *
 * 真要去拉的两处(进房前、每通电话开始时)走 {@link applyFamilyPool} ——
 * 它多管两件事:拉不到时沿用上一份,以及那一行「这一通认的是哪一份」的日志。
 * 这一个留着给用例直接摆池子用。
 */
export function setFamilyPool(families: readonly { id?: unknown, title?: unknown, aliases?: unknown }[] | undefined): void {
  if (families === undefined) { downstreamFamilies = undefined; return }
  const out: SpokenFamily[] = []
  for (const one of families) {
    const id = typeof one?.id === 'string' ? one.id.trim() : ''
    if (id === '') continue
    const title = typeof one.title === 'string' && one.title.trim() !== '' ? one.title.trim() : id
    const aliases = Array.isArray(one.aliases)
      ? one.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '')
      : undefined
    out.push(aliases === undefined || aliases.length === 0 ? { id, title } : { id, title, aliases })
  }
  downstreamFamilies = out.length === 0 ? undefined : out
}

/** 这会儿认家名用的那一池:主人下发的那份,没有就兜底那份。 */
export function familyPool(): readonly SpokenFamily[] {
  return downstreamFamilies ?? FALLBACK_FAMILIES
}

/**
 * ★ **去拉一次回来之后怎么处置**,外加那一行日志(2026-10-03,卡 C;审计材料 2026-10-03 附证 C)。
 *
 * 两处调它、**同一种处置**:工人每次进房前(`main.ts`)、**每通电话开始时**(`agent.ts` 的
 * `refreshSelfBrief`)。从前只有进房前那一次,而 `main.ts` 那个循环**一圈是一次进房、不是
 * 一通电话** —— 工人常驻在房里,她启动之后新装的那一家要等断房重连才认得出。
 *
 * 拉不到时**沿用上一份**(从前进房那一处是 `setFamilyPool(undefined)` → 退回自带兜底)。
 * 理由:上一份是同一台工作台十分钟前给的,比自带那张**更全**(自带那张少掉运行时发现的几家);
 * 把它换成更小更旧的一份不是更诚实,只是更差。**诚实落在日志上** —— 这一行永远说得出
 * 这一通认的是哪一份:工作台那一份、还是自带兜底那一份。
 *
 * 回的是那一行日志(调用方 `console.log` / `log` 它)。**这么写是为了能测**:真进房那一层
 * (`startChannelAgent`)要 LiveKit,仓库里没有测试台,所以处置与措辞落在这个纯函数里。
 */
export function applyFamilyPool(
  got: { ok: true, families: readonly { id?: unknown, title?: unknown, aliases?: unknown }[] }
    | { ok: false, note: string },
): string {
  if (got.ok) {
    const before = downstreamFamilies
    setFamilyPool(got.families)
    if (downstreamFamilies !== undefined) {
      return `[channel-worker] 认得出的家:${familyPool().length} 家(来自工作台)`
    }
    // 回包里一行都认不出来:当成没拉到(沿用上一份),别把整池清成一家都没有。
    downstreamFamilies = before
    return `[channel-worker] 认得出的家:${keptNote()} —— 工作台回的那几行一行都认不出来`
  }
  return `[channel-worker] 认得出的家:${keptNote()} —— ${got.note}`
}

/** 「这一通用的是哪一份」那半句。拉不到时两处共用一种说法。 */
function keptNote(): string {
  return downstreamFamilies === undefined
    ? `自带兜底那 ${FALLBACK_FAMILIES.length} 家`
    : `沿用上一份工作台那 ${downstreamFamilies.length} 家`
}

/** 这一池是从哪来的。**只给日志用**(真机上一眼看出「这通电话认的是哪一份」)。 */
export function familyPoolSource(): 'workbench' | 'fallback' {
  return downstreamFamilies === undefined ? 'fallback' : 'workbench'
}

/**
 * 这一家念给他听叫什么。池子里有就用池子里那个正名,**没有就原样用家名** ——
 * 不猜一个名字出来(运行时发现的那一家家名就是包标识,照原样念也比念错一家好)。
 */
export function familyTitle(id: string): string {
  return familyPool().find(one => one.id === id)?.title ?? id
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

/** 他那句话里的一个词:`word` 是认字用的小写形,`raw` 是他原话里那一截(换正名时要替换的正是它)。 */
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
 * `minus`→`mns`、`manus`→`mns`、`muse`→`ms`、`musi`→`ms`、`claude`→`cld`、`codex`→`cdx`。
 *
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

/** 够格算「像这一家」的最低分。 */
export const SPOKEN_MIN_SCORE = 40

/**
 * 他这句话里点的是哪一家。**唯一高置信就直接当那一家,不问**(维护者:「哪有那么复杂?」);
 * 并列两家才问一句。
 */
export function matchSpokenFamily(said: string, families: readonly SpokenFamily[] = familyPool()): SpokenMatch {
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
  return {
    kind: 'many',
    families: top,
    line: `是${top.map(one => one.title).join('还是')}?`,
  }
}

/**
 * 把他那句话里听错的名字换成正名(送给工作台之前过一遍)。
 * 认不准就**原样返回** —— 不替他改写成某一家。
 */
export function canonicalWho(who: string, families: readonly SpokenFamily[] = familyPool()): string {
  const match = matchSpokenFamily(who, families)
  if (match.kind !== 'one') return who
  const asked = normalize(who)
  if (asked.includes(normalize(match.title))) return who
  // 把那个听错的词换掉:找到得分最高的那一截,整截替换成正名。
  let target: string | undefined
  let score = 0
  for (const { word, raw } of spokenWords(who)) {
    const one = spokenScore(word, match.title)
    if (one > score) { score = one; target = raw }
  }
  if (target === undefined) return `${who}(${match.title})`
  return who.replace(target, match.title)
}
