/**
 * 时间区间的并列排布(日历的通用做法):按起点排好,相交的连成一簇;簇内贪心分小列,
 * 一列里上一件结束(首尾相接也算)才放下一件。每簇的列数 = 它同时最多几件。
 * 「按日期」日程与「人和 Agent 占用」共用这一份;装不下时怎么收,由各自的视图定。
 */
export interface LaneCluster<T> {
  placed: { item: T, lane: number }[]
  lanes: number
  start: number
  end: number
}

export function packLanes<T extends { start: number }>(items: readonly T[], endOf: (item: T) => number = item => (item as T & { end: number }).end): LaneCluster<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || endOf(a) - endOf(b))
  const out: LaneCluster<T>[] = []
  let cluster: T[] = []
  let clusterEnd = -Infinity
  const flush = (): void => {
    if (cluster.length === 0) return
    const laneEnds: number[] = []
    const placed = cluster.map((item) => {
      let lane = laneEnds.findIndex(end => end <= item.start)
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0) }
      laneEnds[lane] = endOf(item)
      return { item, lane }
    })
    out.push({ placed, lanes: laneEnds.length, start: cluster[0]!.start, end: clusterEnd })
    cluster = []
    clusterEnd = -Infinity
  }
  for (const item of sorted) {
    if (item.start >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, endOf(item))
  }
  flush()
  return out
}
