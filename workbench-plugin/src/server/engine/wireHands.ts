/**
 * ★ **引擎接线上那两只手的判断,搬出 `index.ts`**(2026-10-03,卡「接缝清理」第 2 条;
 * 决策记录「2026-10-03 早」⑦)。
 *
 * 前因(`docs/交接-1002-引擎接线与删复制品.md` 第六节 ③④):删旧管线那一张卡把
 * 「叫那一家到台前」与「这件活在哪个目录干」接到了 `index.ts` 里 —— 而 `index.ts` 是宿主入口,
 * 用例够不到(`tests/server-dispatch-real-helper.test.ts` 那一组只能注入 `bringToFront` 钉次序,
 * 钉不到里面那一段反查)。于是:
 *
 * - 「一家的包标识 → 窗位叠里那一格的键」(`c-muse` 这种反查)从前在
 *   `dispatchClient.CLIENT_DISPATCH_DOCK_KEYS` 旁边有用例钉着,搬进 `index.ts` 之后**没人钉**;
 * - `workdir(job)`(按卡查「许不许改文件」)只有真机那一跑的 rollout 文件作证。
 *
 * 这一份把那两段**原样**搬成纯函数(依赖都从外面给),`index.ts` 只剩一行调用。
 * **行为一个字不变** —— 这是重构,不是修法。
 *
 * 为什么放在 `engine/` 下:这两只手是**引擎接线**要的那几格
 * (`window.bringToFront` / `codex.workdir`,契约在 `adapter.ts`),与 `wire.ts` 同一层。
 * 契约本身一个字没动。
 */
import type { CodexWorkdir } from './adapters/codex.ts'

/** {@link bringAgentToFront} 要的那三样(生产里是 `apps.keyFor` / `dock.switchTo` / `open -b`)。 */
export interface BringToFrontDeps {
  /**
   * 这个包在**窗位叠**里是哪一格的键(`apps.ts` 的 `registry.keyFor`)。
   * 认不出就 `undefined` —— 豆包这种没进过基础七应用那张表的就没有键。
   */
  keyFor: (bundleId: string) => Promise<{ key: string } | undefined>
  /** 切到窗位叠那一格(`dock.switchTo`;摆位,不保证开窗)。 */
  switchTo: (key: string) => Promise<{ ok: boolean }>
  /** 退路:直接叫它到前面(`open -b <包>`)。 */
  openApp: (bundleId: string) => Promise<{ ok: boolean }>
}

/**
 * **把那一家叫到台前**(窗口适配器的 `bringToFront` 那一格)。
 *
 * 两档,次序是定死的:① 窗位叠里认得它(`keyFor`)就先切那一格 —— 切过去了就算成了;
 * ② 认不出、切不过去、或者这一路自己抛了,一律退到 `open -b`。
 *
 * **反查那一步抛了不许往外窜**:窗位叠认不认得它与「能不能叫到台前」是两件事,
 * 认不出就直接叫它到前面(这一句注释从 `index.ts` 原样搬过来)。
 */
export async function bringAgentToFront(deps: BringToFrontDeps, bundleId: string): Promise<{ ok: boolean }> {
  try {
    const key = (await deps.keyFor(bundleId))?.key
    if (key !== undefined) {
      const switched = await deps.switchTo(key)
      if (switched.ok) return { ok: true }
    }
  }
  catch { /* 窗位叠认不出就直接叫它到前面 */ }
  return { ok: (await deps.openApp(bundleId)).ok }
}

/** 判 {@link codexWorkdirOf} 要用到的那一点点卡面(不引 `protocol.ts` 那一整套,免得这一处又成一条接缝)。 */
export interface CodexWorkdirCard {
  id: string
  /** 派活那一次写在卡上的:这件活在哪个目录干。 */
  dispatch?: { cwd?: string }
}

export interface CodexWorkdirDeps {
  /** 看板上此刻那几张卡。自己抛了就当**查不到**(见下面第四档)。 */
  cards: () => Promise<readonly CodexWorkdirCard[]>
}

/**
 * **这件活在哪个目录干、许不许改文件**(Codex 协议适配器的 `workdir` 那一格)。
 *
 * 已拍板(决策记录 2026-10-02 夜):**缺席 = 只读**。四档,只有第一档给写:
 *
 * | 这一下 | 结果 |
 * |---|---|
 * | 卡上写明了目录 | `{ cwd, writes: true }` —— `workspace-write` + 这个 cwd |
 * | 有卡、卡上那一格空着(没派过活 / 派的不是写代码的活) | `{ writes: false }` |
 * | 这件活压根没挂卡(`job.itemId` 缺席 / 全是空白) | `{ writes: false }` |
 * | 带了事项 id、可看板上**查不到**那张卡(或者查看板自己抛了) | `{ writes: false }` |
 *
 * 最后两档是纪律不是性能:**查不出来就按最保守那一档**,不许拿一个猜来的目录给它写权限。
 *
 * ★ 这一步**不去 stat 那个目录**(今天的行为一字不变):目录在不在是 `codex app-server`
 * 自己那一下的事(它答得出「这个目录没有」),工作台先 stat 一遍只会多一份会过期的判断。
 */
export async function codexWorkdirOf(deps: CodexWorkdirDeps, job: { itemId?: string }): Promise<CodexWorkdir> {
  const itemId = job.itemId
  if (itemId === undefined || itemId.trim() === '') return { writes: false }
  try {
    const card = (await deps.cards()).find(one => one.id === itemId)
    const cwd = card?.dispatch?.cwd
    // 卡上写明在哪个目录干的才给写(`workspace-write`);没卡 / 没目录一律只读 —— 最保守那一档。
    return cwd === undefined || cwd.trim() === '' ? { writes: false } : { cwd, writes: true }
  }
  catch { return { writes: false } }
}
