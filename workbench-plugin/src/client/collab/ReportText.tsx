import { useEffect, useState } from 'react'
/** 只折叠真实长文本；是否报告由正式 kind/category 决定，不从正文猜分类。 */
export function ReportText({ text, report }: { text: string, report: boolean }) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [text])
  const long = report && (text.length > 240 || text.split('\n').length > 6)
  return <div className="ben-cl__report-text">
    <p>{long && !expanded ? `${text.slice(0, 240)}…` : text}</p>
    {long && <button type="button" className="ben-cl__link" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收回报告' : '展开报告'}</button>}
  </div>
}
