/**
 * 等他点头的布局改动(2026-09-22,「用自然语言改布局」)。
 *
 * 链路四步,与「开发一个小工具」那条**逐字同形**(server/devTool.ts):
 *
 *   ① **认出来**  `POST /butler/item` 收到的文本被 `parseLayoutWords` 认成了一份动作草案
 *   ② **先复述**  不改布局、不落一个字节 —— 先摆一条「我把 X 挪到 Y,对吗?」
 *   ③ **他点头**  `POST /layout/confirm { id }`(PRD §9 门槛③:不得自行执行)
 *   ④ **才改**    存一份可回退的布局快照 → `applyLayoutActs` → 落盘 → 一句「挪好了,
 *                 不合适说『撤销』」
 *
 * 两条链路同形不是巧合:它们是同一条规矩的两个客户 —— **事务官替他动他的东西之前,
 * 先把自己的理解说一遍**。形状不一样的话,他在两处要学两套。
 *
 * ## 为什么落盘
 *
 * 从"说完那句话"到"点确认"中间可能隔着一次刷新、一次重启。那条草案只活在内存里的话,
 * 他回来就得重说一遍(同 dev-tools.json 的理由)。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LayoutAskView } from '../protocol.ts'

export function defaultLayoutAskFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/layout-asks.json`
}

/**
 * 同时待确认的上限。
 *
 * 比小工具那条(5)紧:布局改动是**互相影响**的 —— 攒着三条「把 X 挪到项目区下面」,
 * 先点哪一条会决定另外两条落在哪儿,而他在卡片上看不出这层先后。留 2 条已经够
 * "刚说完又想起一句"这种情况了。
 */
export const MAX_PENDING_ASKS = 2

/** 落盘那一份。 */
export interface LayoutAskFile {
  version: 1
  pending: LayoutAskView[]
}

export interface LayoutAskStore {
  load: () => Promise<void>
  pending: () => readonly LayoutAskView[]
  find: (id: string) => LayoutAskView | undefined
  add: (ask: LayoutAskView) => Promise<{ ok: boolean, error?: string }>
  drop: (id: string) => Promise<boolean>
}

function isAsk(value: unknown): value is LayoutAskView {
  const one = value as Partial<LayoutAskView> | null
  return typeof one?.id === 'string'
    && typeof one.request === 'string'
    && typeof one.restate === 'string'
    && Array.isArray(one.actions)
    && one.actions.length > 0
}

export function createLayoutAskStore(options: { file: string }): LayoutAskStore {
  let pending: LayoutAskView[] = []

  const save = async (): Promise<void> => {
    await mkdir(dirname(options.file), { recursive: true })
    const payload: LayoutAskFile = { version: 1, pending }
    await writeFile(options.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(options.file, 'utf8')) as Partial<LayoutAskFile>
        // 文件坏了 / 没有 = 一条待确认都没有。**不抛**:一份读不懂的 json 不该让工作台起不来。
        pending = Array.isArray(raw.pending) ? raw.pending.filter(isAsk) : []
      }
      catch { pending = [] }
    },
    pending() { return pending },
    find(id) { return pending.find(item => item.id === id) },
    async add(ask) {
      if (pending.length >= MAX_PENDING_ASKS) {
        return { ok: false, error: `还有 ${pending.length} 条布局改动没确认,先点一下那几张卡` }
      }
      pending = [...pending, ask]
      await save()
      return { ok: true }
    },
    async drop(id) {
      const next = pending.filter(item => item.id !== id)
      if (next.length === pending.length) return false
      pending = next
      await save()
      return true
    },
  }
}
