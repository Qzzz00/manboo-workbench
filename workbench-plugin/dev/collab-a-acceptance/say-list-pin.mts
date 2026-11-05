/**
 * 1a 矩阵句子的确定性「听懂」钉版(行为断言用,不经真模型)。
 * serve.mts(浏览器/单句腿)与 run-1a-matrix.mts(假上游模式)共用一份,不各养一套。
 */
/** 1a 验收的确定性「听懂」:每个矩阵句子回一份钉死的命令清单(行为断言用,不经真模型)。 */
export function sayListFor(said: string): unknown {
  if (said.includes('发给客户') && said.includes('不用现在发')) {
    return { addressed: true, items: [{ kind: '记', title: '周四下午给客户发样片', risk: 'none', confidence: 0.9, why: 'qa-s2' }] }
  }
  if (said.includes('派给 Claude') && said.includes('女声')) {
    return { addressed: true, items: [
      { kind: '记', title: '周四下午给客户发样片', risk: 'none', confidence: 0.9, why: 'qa-s4a' },
      { kind: '办', title: '把样片剪一版', who: 'claude', risk: 'none', confidence: 0.9, why: 'qa-s4b' },
      { kind: '改', title: '换个女声', risk: 'none', confidence: 0.9, why: 'qa-s4c' },
    ] }
  }
  if (said.startsWith('记三条')) {
    return { addressed: true, items: [
      { kind: '记', title: '周四发样片', risk: 'none', confidence: 0.9, why: 'qa-s5a' },
      { kind: '记', title: '周五交发票', risk: 'none', confidence: 0.9, why: 'qa-s5b' },
      { kind: '记', title: '下周一约 B 客户', risk: 'none', confidence: 0.9, why: 'qa-s5c' },
    ] }
  }
  if (said.includes('顺便再记一下')) {
    return { addressed: true, items: [
      { kind: '记', title: '周四发样片', risk: 'none', confidence: 0.9, why: 'qa-s6a' },
      { kind: '记', title: '周五交发票', risk: 'none', confidence: 0.9, why: 'qa-s6b' },
    ] }
  }
  if (said.includes('样片')) {
    return { addressed: true, items: [{ kind: '记', title: '周四下午把样片发给客户', risk: 'none', confidence: 0.9, why: 'qa-default' }] }
  }
  return undefined
}
