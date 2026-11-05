/**
 * 一根细进度条。看板里三处用到:冲刺完成度、冲刺时间进度、模块完成度。
 *
 * 2026-08-25 Ben:"优先级、负责人、预期结束时间,冲刺模块,都没有考虑在可视化上的优化"。
 * 原来这几处全是文字("5/11"、"2026-08-25 → 2026-09-07"),要读、要心算。条状的好处是
 * 余光就能比较——哪个模块落后、时间过了多少,不用逐个看数字。
 *
 * **数字仍然留着**(条旁边的 `label`),不拿条替代数字:条给的是量感,数字给的是事实,
 * 只剩条的话"到底还差几条"就没人回答得了。
 *
 * 分母为 0 时**不画条也不画 0%**——那种情况是"这里还没有东西",不是"完成度为零",
 * 画一根空条会让人以为一堆活没干(D13:没有信息不该编成一个数)。
 */
export function Meter({ done, total, label, tone }: {
  done: number
  total: number
  /** 条旁边那行字。不传就只有条。 */
  label?: string
  /** 'time' 用中性色——时间进度不是成绩,别让它看起来像"完成度很高"。 */
  tone?: 'done' | 'time'
}) {
  if (total <= 0) {
    return label === undefined ? null : <span className="ben-wb__meter-label">{label}</span>
  }
  const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)))
  return (
    <span className="ben-wb__meter" data-tone={tone ?? 'done'}>
      <span className="ben-wb__meter-track" aria-hidden="true">
        <span className="ben-wb__meter-fill" style={{ width: `${pct}%` }} />
      </span>
      {label !== undefined && <span className="ben-wb__meter-label">{label}</span>}
    </span>
  )
}
