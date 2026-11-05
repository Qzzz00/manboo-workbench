import { useEffect, useState } from 'react'
import type { RunSegment, WorkbenchState } from '../protocol.ts'
import { collabApi } from './collab/collabApi.ts'

/*
 * 展开窗「在跑的事项」与 /collab/runs 同一本账(2026-10-28,断点④):在跑哪几件由片段判
 * (口径在 runningTaskIdsOfRuns,与 /collab/capacity 的 running_jobs 同判据),不读 /state.running
 * 快照 —— 快照与任务日志曾各数各的(窗里写 0、协作区写 2)。
 *
 * ★ **一次请求读全部未结卡**(2026-10-29,任务书「在跑的事项要数到命令行真在跑的活」洞 2):
 * 从前按板上目标的 id 逐个 `?goal_id=` 查 —— 悬浮球里说一句建的卡**没归目标**(`goal_id` 空),
 * 于是哪一本都查不到它,在跑的命令行活永远显示 0。服务端无参读法回全部未结卡的片段,
 * 这里整本一次取回(有目标 / 没归目标的都在里面),收起球与展开窗同源(runningCountOf 不改)。
 * 回包不是数组记 'missing',那一列退回快照口径,不说瞎话。api 缺席(undefined)就不发请求,
 * 返回 undefined(调用方退回快照口径)。
 */
export function useCollabRuns(
  state: Pick<WorkbenchState, 'tasks'>,
  api: { baseUrl: string, fetchImpl?: typeof fetch } | undefined,
): readonly RunSegment[] | 'missing' | undefined {
  const [runFacts, setRunFacts] = useState<readonly RunSegment[] | 'missing' | undefined>(undefined)
  const baseUrl = api?.baseUrl, fetchImpl = api?.fetchImpl
  useEffect(() => {
    if (baseUrl === undefined) return
    const client = collabApi(baseUrl, fetchImpl ?? fetch)
    let alive = true
    void client.get<{ runs?: RunSegment[] }>('/collab/runs')
      .then(one => {
        if (!alive) return
        setRunFacts(Array.isArray(one?.runs) ? one.runs : 'missing')
      })
    return () => { alive = false }
  }, [baseUrl, fetchImpl, state.tasks])
  return runFacts
}
