/**
 * 「先问我」那一档在等他批的操作(2026-09-24,统一输入框)。
 *
 * DSH 会话里一次越界的操作(工作区外写文件、一条要批的命令)以前只能在 DSH 自己的网页里点,
 * 而他平时不开那个网页 —— 等于没人批,那一轮就卡在那儿。现在挂在档上(和手机首页上),点了就算数。
 * 一条都没有时整块不渲染。
 *
 * 2026-09-25(卡 M):每一条换成说人话的那一张(`ApprovalAsk`:要做什么、为什么、放开到多大、同类的都允许、看原始)。
 */
import type { PendingApprovalView } from '../../protocol.ts'
import { ApprovalAsk } from '../ApprovalAsk.tsx'

export function ApprovalRows({ approvals, baseUrl, fetchImpl, onReceipt }: {
  approvals: readonly PendingApprovalView[]
  baseUrl: string
  fetchImpl: typeof fetch
  onReceipt?: (text: string) => void
}) {
  if (approvals.length === 0) return null
  return (
    <div className="wb-approvals" role="group" aria-label="等你批准">
      {approvals.map(one => (
        <ApprovalAsk key={one.id} approval={one} baseUrl={baseUrl} fetchImpl={fetchImpl} {...(onReceipt === undefined ? {} : { onReceipt })} />
      ))}
    </div>
  )
}
