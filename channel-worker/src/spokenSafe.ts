/**
 * **她嘴里不该有的那几样**(2026-09-28,卡 CF 第 6–8 条)。
 *
 * ## 两件真机上听到的事
 *
 * 1. 「狗东西接不…」。诊断包 工作台诊断包-20260928-160317 最后一句:
 *    「……事就卡在这一步:缺一把豆包火山的钥匙。狗东西接不」。
 *    **查清了这个词从哪来**:不在称呼表里(`persona.addresses` 只有「老板」「Ben」「阿荣」这类)、
 *    不在人设与提示词里(仓库里 grep 不到这三个字)、也不是识别结果(那一行是 `她说:`,
 *    是模型吐出来的原文)—— 就是**模型自己生的**。所以两头一起堵:提示词里明着禁
 *    (`workbench-plugin/src/server/channel.ts` 的「说话的规矩」),
 *    加上这一份把我们**自己拼的**每一句过一遍。
 *    **边界要说清**:模型那一路是流式合成的,整句还没成形就已经在念了,
 *    这一份拦不住它 —— 它只保证「工作台拼给她念的话」里没有这些字。
 * 2. 「插一句:『<整条标题连三条确认点>』没成:派给 豆包办公 没派出去:窗口:这台电脑上还没接上 doub」。
 *    维护者:「太啰嗦了……念了一遍经书,又来一个什么插一句」。内部前缀(`窗口:`/`接口:`)、
 *    包标识、环境变量名都是给查日志的人看的,**不念给他听**(卡 CF 第 8 条)。
 *
 * 全是纯函数。
 */

/**
 * 骂人的话。**只写多字的词** —— 单字(「操」)会把「操作」这种正常词切了,
 * 拦住一句脏话的代价不该是把她的话切碎。长的排在前(「他妈的」先于「他妈」)。
 */
const BAD_WORDS: readonly string[] = [
  '狗东西', '他妈的', '妈的', '他妈', '傻逼', '傻子', '混蛋', '废物', '滚蛋', '去死', '智障',
]

/**
 * 这一句念出去之前过一遍:骂人的话**整个去掉**(不换成 `*`,念出来更难听),
 * 顺手收拾掉去掉之后留下的空格与重复标点。她那句话的别的部分一个字不动。
 */
export function spokenSafe(text: string): string {
  let out = typeof text === 'string' ? text : ''
  for (const word of BAD_WORDS) out = out.split(word).join('')
  return out
    .replace(/[ \t　]{2,}/g, ' ')
    .replace(/^[ \t　,,。、;;::!!]+/, '')
    .trim()
}

/** 这一句里有骂人的话吗(日志要记一行:模型这一回合又生了一个)。 */
export function hasBadWord(text: string): boolean {
  const said = typeof text === 'string' ? text : ''
  return BAD_WORDS.some(word => said.includes(word))
}

/** 念给他听的那一句最多多长(字)。再长就不是「插一句」了。 */
export const PLAIN_REASON_MAX = 44

/**
 * 卡上那句 note → **念给他听的一句人话**(卡 CF 第 6、8 条)。
 *
 * 四刀,顺序固定:
 * 1. **只留第一段**(`;` 之前):三只手各有各的原因,他要的是第一条走不通的那一个;
 * 2. 内部前缀(`窗口:`/`接口:`/`后台那条路:`)去掉;
 * 3. 包标识(`com.work.pc.doubao`)换成「它」,环境变量那半句(`(缺 RELAY_DOUBAO_KEY)`)整个去掉;
 * 4. 太长就截到 {@link PLAIN_REASON_MAX} 字。
 *
 * 一句话都不剩(note 本来就是空的 / 全是内部字段)时回 `undefined` —— 那时调用方退回别的说法,
 * **不编一个原因**(D13)。
 */
export function plainFailureWhy(note: string | undefined): string | undefined {
  const raw = (note ?? '').trim()
  if (raw === '') return undefined
  let said = (raw.split(';')[0] ?? '').trim()
  said = said
    // 「窗口:」「接口:」「后台那条路:」这类是给查日志的人分段用的。
    .replace(/(窗口|接口|后台那条路)[::]\s*/g, '')
    // 包标识:三段以上的点分小写串。后面紧跟「的」时换成「它的」,否则整段去掉。
    .replace(/\b[a-z][a-z0-9]*(?:[.-][a-z0-9-]+){2,}\b\s*的/g, '它的')
    .replace(/\b[a-z][a-z0-9]*(?:[.-][a-z0-9-]+){2,}\b/g, '')
    // 环境变量那半句:括号里带大写下划线名字的(`(缺 RELAY_DOUBAO_KEY)`)。
    .replace(/[((][^())]*[A-Z][A-Z0-9_]{3,}[^())]*[))]/g, '')
    .replace(/[ \t　]{2,}/g, ' ')
    .trim()
  said = spokenSafe(said)
  if (said === '') return undefined
  const chars = [...said]
  return chars.length <= PLAIN_REASON_MAX ? said : `${chars.slice(0, PLAIN_REASON_MAX).join('')}`
}
