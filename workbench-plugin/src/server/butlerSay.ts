/**
 * 旧 say 管线的遗物,2026-10-29 删规矩第一批入口归一后只剩一件:
 *
 * {@link affirmFast} —— 答**中枢护栏**挂着的那一问时的点头快判(「好,去建吧」这一类只有一种读法的
 * 短句;理解中枢 `hub/run.ts` 在用)。逐字命中选项原话那一支也在中枢里,不在词表。
 *
 * 随旧路一并删掉的(审计 A#9 / A#20 / A#21;这些意图现在全部由中枢命令表出):
 * 旁人声快判(addressedFast)、旧路快路径(fastPath)、四档置信度(decidePolicy)、
 * 标题清洗(cleanTitle)、改口/并件(applyAmend)、回话拼装(sayFor)、清单件类型(SayPlanItem)。
 */
import { SAY_KINDS, RISKS } from '../protocol.ts'
export { SAY_KINDS, RISKS }

/**
 * 肯定短句快判:她回「好,去建吧」这类 = 解冻挂着的那一问(中枢护栏问的第二拍)。
 * 收得窄:只认明确的点头,不猜「嗯」单字以外的含糊话;否定/新话一律 false 走正常听懂(交模型)。
 */
export function affirmFast(said: string): boolean {
  const text = said.trim().replace(/[。!！~～\s]+$/u, '')
  if (text === '') return false
  if (/^(?:不|别|先别|算了|不用)/u.test(text)) return false
  // 点头词 + 可选的「去建吧/就这么办」尾巴:好(的)/行/可以/嗯/确认;另有光秃秃的「去吧/办吧/建吧」。
  return /^(?:好|好的|行|可以|嗯|确认)[,，]?(?:去?[建办做干]吧?|就这么办|去吧)?$/u.test(text)
    || /^(?:去吧|去办|去做|办吧|建吧|就这么办)$/u.test(text)
}
