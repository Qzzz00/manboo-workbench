/**
 * 「要一份文件」这件事**没到她手机上就不算办完**(2026-10-04,卡 `claude/phone-file-send-loop`)。
 *
 * ## 为什么有这一处
 *
 * 10-04 早(事项 `t-63a9291b`,DSH 会话 `session-d0d457fa`)她在手机上说
 * 「官网逐字稿,这份文件发到我这个手机上。」。那一句没被认出来(判法见 `fileFetch.ts` 的 ① 节),
 * 落成一件普通事项交给事务官;事务官手里没有「把文件推到手机」的路,头两轮各跑十几步去 grep
 * 工作台自己的源码、都以 `aborted` 收场(她看到的「阻塞了两次」),第三轮把文件拷进事务官文件夹、
 * 回了一句「你在手机上再打一句『把官网逐字稿发我』」。**一个字节都没到她手机上**,
 * 而那张卡随即 `done`、note 写的是「只是问了一句」。
 *
 * 记成「只是问了一句」不是文案错了,是**判据漏了一格**:`casualAsk.ts` 的三问是
 * 「派出去了没 / 改了几个文件 / 有要交回的东西没」,三问全照卡上与会话里数出来的事实判 ——
 * 而那一轮是用 `bash cp` 拷的文件,写类工具一次没用(`filesChanged` 数不出 bash,
 * 那条已知缺口写在 `casualAsk.ts` 的注释里),交付物里只有一段回答。三问全否 → 收掉。
 *
 * 维护者 10-02 的口径:「不要拿着打补丁的心态,要有机制上的调整。」所以这里不去给
 * `casualAsk` 多加一个词、也不去数 bash:**这一类事项的"办完"换一个判据 —— 传输回执**。
 *
 * ## 机制:要回执的事项,登记在这里
 *
 * 1. **登记**:`/butler/item` 认出这句话像在要一份文件(`fileFetch.ts` 的 `fileWantHint`,
 *    宽的那一档),这件事落给事务官的同时在这里登记一条 {@link FileDeliveryNeed};
 * 2. **开单**:事务官走 `POST /butler/send-file` 找到文件、开取件单、把卡摆到她手机上
 *    ({@link FileDeliveryStore.offered});
 * 3. **回执**:她点了那张卡,文件真到了手机 —— 三条路报回同一处({@link FileDeliveryStore.receipt}):
 *    在家直连下载完(`GET /files/offer/<单号>` 流走完)、出门经房间推完(工人报
 *    `POST /channel/transfer`,记录里带单号)、手机自己写完盘并对上 sha256(`POST /files/received`);
 * 4. **收尾**:会话结束那一刻(`butlerLifecycle.ts`)先问这里一句「这件事的回执到了吗」——
 *    没到就**不许 done、不许「只是问了一句」**,卡进「阻塞」并如实写
 *    「找到了 X,但还没送到你手机:<原因>」,按既有规矩回电 / 通知她
 *    (`callOut.ts`:阻塞 · 等你输入 → 「等你回答」那一通)。
 *
 * ## 纪律
 *
 * - **一个数都不编**:没找到文件就说没找到,推失败就把那一句原因原样写上;
 *   「在传了」不是「到了」—— 只有回执算到了。
 * - **落盘了**(2026-10-04 午后统筹定,卡 `claude/three-small-1004`):台账落
 *   `~/.dsh/workbench/file-delivery.json`(与 `call-out.json` / `tasks.json` 同一个目录规格)。
 *   从前它只在内存里 —— 工作台重启一次,「还差一个回执」这件事就忘了,那张卡于是又成了「办完了」。
 *   读写那几行在 {@link import('./fileDeliveryFile.ts')} 里(**这个文件照旧一行 I/O 都没有**),
 *   老台账里没有的格一律当缺席、看不懂的那一条丢掉(不编)。
 * - 这个文件里**一行 I/O 都没有**:找文件、开单、发卡全在 `http.ts` 那一侧,这里只记账。
 *
 * ## 三条路都登记,不只是手机打字那一条
 *
 * - **手机 / 电脑打字要文件**:`/butler/item` 登记 → `/butler/send-file` 开单 → 三条回执路;
 * - **电话里要文件**(2026-10-04 午后统筹定):工人那件 `wb_send_file` 真传之前先来登记
 *   (`POST /files/phone-delivery`),拿一个单号,传完报流水时把单号带回来(`TransferEntry.offer`)——
 *   于是「她在电话里要的文件没到」也会在看板上显形。那一条**没有卡要她点**(字节是工人直推的),
 *   所以 {@link FileDeliveryNeed.pushed} 立着,「为什么还没到」说的是「正在传」而不是「点一下就到手」。
 */
import type { FileAskView } from './fileFetch.ts'

/** 一条登记最多留多久。过了就不再拦收尾(她早走开了,卡还在看板上)。 */
export const DELIVERY_NEED_TTL_MS = 24 * 60 * 60 * 1000

/** 内存里最多留几条登记。 */
export const DELIVERY_NEED_KEEP = 200

/** 还没开单时的原因:事务官一下都还没走。 */
export const DELIVERY_WHY_NOT_SENT = '事务官还没把它推到你手机上'

/** 开了单、卡摆在她手机上、她还没点。**这不是失败**,但也不是到了。 */
export const DELIVERY_WHY_WAITING_TAP = '卡已经摆在你手机上了,点一下就到手'

/**
 * 字节已经在路上(电话里那条:工人用 `wb.file` 直推,**没有卡要她点**)。
 * 这一句不许说成「点一下就到手」—— 她手机上压根没有一张卡。
 */
export const DELIVERY_WHY_PUSHING = '正在往你手机上传,还没传完'

/**
 * ★ **卡推过去了,可她手机一直没来取**(2026-10-04 午后统筹定)。
 *
 * 那张卡是经 `GET /files/pending` 取的,**那条路是这一版手机包才有的** ——
 * 老包压根不问这一句,于是卡永远摆在那儿、她什么都看不见,而 8791 这一侧还在说
 * 「点一下就到手」(那是句假话)。超过 {@link DELIVERY_PENDING_GRACE_MS} 还没有哪一次
 * `/files/pending` 来过,就把这句实话写到卡上。
 *
 * **两种可能都说出口**(不编一个):要么手机端该更新了,要么它这会儿没联网。
 */
export const DELIVERY_WHY_PHONE_TOO_OLD = '卡推过去了,但你手机一直没来取 —— 手机端要更新才能收到(或者它这会儿没联网)'

/**
 * 等多久还没来取就改说那句。手机每 5 秒问一次(`PENDING_ASK_POLL_MS`),
 * 60 秒 = 十二拍都没来过 —— 不是慢,是这条路不通。
 */
export const DELIVERY_PENDING_GRACE_MS = 60 * 1000

/** 事务官找不到那个文件(它自己报上来的原因)。 */
export const DELIVERY_WHY_NOT_FOUND = '没找到要发的那个文件'

/**
 * 卡上那一句。**不说「办完了」,也不说「发过去了」** —— 说清找到了什么、为什么还没到。
 */
export function notDeliveredNote(what: string | undefined, why: string): string {
  const head = what === undefined || what.trim() === '' ? '还没送到你手机' : `找到了「${what.trim()}」,但还没送到你手机`
  return `${head}:${why}`
}

/**
 * 卡推到她手机上之后**回给事务官**那一句(`POST /butler/send-file` 的 note)。
 *
 * 末尾那一句不是客套:10-04 早上它回的是「弹出来的卡点一下就到手」然后把事项记成了完成。
 * 推出去 ≠ 到了,所以这里明说**等回执**。
 */
export function sendFileNote(name: string, device: string): string {
  return `「${name}」的卡已经推到「${device}」上了,她点一下就到手。`
    + '**等传输回执** —— 回执没到这件事就不算办完,别回「发过去了」,也别叫她再说一遍。'
}

/** 到了之后卡上那一句。 */
export function deliveredNote(what: string, bytes: number): string {
  return `「${what}」已经到你手机上了(${humanBytes(bytes)})。`
}

/** 字节数 → 人话。与 `channel-worker/src/files/transfers.ts` 的 `humanSize` 同一套说法。 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不详'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface FileDeliveryNeed {
  /** 哪张卡。 */
  item_id: string
  /** 她那句原话。 */
  request: string
  /** 认出来要找的那个东西(认不出就缺席 —— 事务官自己去问她一句)。 */
  query?: string
  /** 送到哪台设备(她说那句话时手里那台)。 */
  device_id: string
  device_name: string
  created_at: number
  /** 事务官找到的那个文件名(开单之后才有)。 */
  what?: string
  /** 开出去的取件单号(她点一下取的就是其中一张)。 */
  offers: readonly string[]
  /** 摆在她手机上等她点的那张卡。取到了就撤掉。 */
  ask?: FileAskView
  /** 真到了:时刻、文件名、字节数。 */
  delivered?: { at: number, name: string, bytes: number }
  /** 最近一次没成的原因(原样写在卡上)。 */
  why?: string
  /**
   * ★ **字节是工人直推的,没有卡要她点**(2026-10-04:电话里那件 `wb_send_file`)。
   * 立着的时候「为什么还没到」说 {@link DELIVERY_WHY_PUSHING},
   * 而且永远不是「等你输入」(没有一下要她点)。
   */
  pushed?: true
}

/** 一条流水之外的那一本:落盘那份文件的形状(见 `fileDeliveryFile.ts`)。 */
export interface FileDeliveryFile {
  version: 1
  needs: readonly FileDeliveryNeed[]
}

/** 落盘 / 读回那两下(实现在 `fileDeliveryFile.ts`;不传 = 照旧只在内存里)。 */
export interface FileDeliveryPersist {
  /** 启动时读一次。读不出来 / 看不懂就回 undefined,台账从空的开始。 */
  load: () => readonly FileDeliveryNeed[] | undefined
  /** 账本一动就写一次。**绝不抛**(写不下去不该把下载那条流打断)。 */
  save: (needs: readonly FileDeliveryNeed[]) => void
}

export interface FileDeliveryStore {
  /**
   * 登记一条:这件事要把一个文件送到她手机上。同一张卡再登记一次 = 覆盖(她又说了一遍)。
   * `pushed` 立着 = 字节是工人直推的(电话里那条),没有卡要她点。
   */
  expect: (input: { itemId: string, request: string, query?: string, deviceId: string, deviceName: string, pushed?: boolean }) => FileDeliveryNeed
  /** 这张卡登记过吗。 */
  need: (itemId: string) => FileDeliveryNeed | undefined
  /** 事务官开了单:记下文件名与单号,把卡摆到她手机上。 */
  offered: (itemId: string, input: { what?: string, offers: readonly string[], ask?: FileAskView }) => FileDeliveryNeed | undefined
  /** 事务官报一句「这一下没成」(找不到文件、超上限、推不过去)。 */
  failed: (itemId: string, why: string) => FileDeliveryNeed | undefined
  /**
   * 回执:某一张取件单取成了 / 没取成。三条路都报到这里来,**按单号认是哪件事**。
   * 认不出那张单(别的路开的、过期清掉了)就什么都不做、回 undefined。
   */
  receipt: (input: { offer: string, ok: boolean, name?: string, bytes?: number, error?: string }) => FileDeliveryNeed | undefined
  /**
   * 这件事还差一个回执吗 —— 差就回一句**如实的话**(收尾那一步照它写卡)。
   * 没登记过、已经到了、登记太久了 → undefined(照旧走老路,一个字不改)。
   */
  pending: (itemId: string) => { what?: string, why: string, waitingTap: boolean } | undefined
  /**
   * 摆在这台设备上、等她点的那几张卡(`/state` 带下去)。
   * **这一下同时是「这台手机认得 `/files/pending` 这条路」的证据**(见 {@link DELIVERY_WHY_PHONE_TOO_OLD})。
   */
  asksFor: (deviceId: string) => readonly FileAskView[]
  /** 全部登记(体检 / 用例用)。 */
  list: () => readonly FileDeliveryNeed[]
  /** 不再盯这一条(她自己把卡收了)。 */
  forget: (itemId: string) => void
}

export function createFileDeliveryStore(
  deps: { now?: () => number, ttlMs?: number, keep?: number, persist?: FileDeliveryPersist } = {},
): FileDeliveryStore {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DELIVERY_NEED_TTL_MS
  const keep = deps.keep ?? DELIVERY_NEED_KEEP
  const needs = new Map<string, FileDeliveryNeed>()
  /** 哪几台手机来问过 `/files/pending`。**只在内存里**:它说的是「这一轮里这台来过」,不是一件发生过的事。 */
  const polled = new Map<string, number>()

  /**
   * 读回落盘那一份(2026-10-04)。过期的那几条读回来就丢掉(同 `prune`),
   * 看不懂的那几条在 `fileDeliveryFile.ts` 里已经滤过。
   */
  const loaded = deps.persist?.load()
  if (loaded !== undefined) {
    const t = now()
    for (const need of loaded) if (t - need.created_at <= ttlMs) needs.set(need.item_id, need)
  }

  /** 账本一动就写一次。**写不下去只是没落盘**,台账照旧在内存里管事。 */
  function flush(): void {
    if (deps.persist === undefined) return
    try { deps.persist.save([...needs.values()]) }
    catch { /* 落盘失败不该把传输那条流打断 */ }
  }

  function prune(): void {
    const t = now()
    for (const [id, need] of needs) if (t - need.created_at > ttlMs) needs.delete(id)
    while (needs.size > keep) {
      const oldest = needs.keys().next().value
      if (oldest === undefined) break
      needs.delete(oldest)
    }
  }

  function byOffer(offerId: string): FileDeliveryNeed | undefined {
    for (const need of needs.values()) if (need.offers.includes(offerId)) return need
    return undefined
  }

  return {
    expect(input) {
      prune()
      const need: FileDeliveryNeed = {
        item_id: input.itemId,
        request: input.request,
        ...(input.query === undefined || input.query === '' ? {} : { query: input.query }),
        device_id: input.deviceId,
        device_name: input.deviceName,
        created_at: now(),
        offers: [],
        ...(input.pushed === true ? { pushed: true as const } : {}),
      }
      needs.set(input.itemId, need)
      prune()
      flush()
      return need
    },
    need(itemId) {
      return needs.get(itemId)
    },
    offered(itemId, input) {
      const need = needs.get(itemId)
      if (need === undefined) return undefined
      const next: FileDeliveryNeed = {
        ...need,
        offers: [...need.offers, ...input.offers.filter(one => !need.offers.includes(one))],
        ...(input.what === undefined ? {} : { what: input.what }),
        ...(input.ask === undefined ? {} : { ask: input.ask }),
      }
      // 又开了一张单 = 上一次那个原因不作数了。
      delete next.why
      needs.set(itemId, next)
      flush()
      return next
    },
    failed(itemId, why) {
      const need = needs.get(itemId)
      if (need === undefined) return undefined
      const next = { ...need, why }
      needs.set(itemId, next)
      flush()
      return next
    },
    receipt(input) {
      const need = byOffer(input.offer)
      if (need === undefined) return undefined
      if (input.ok) {
        const next: FileDeliveryNeed = {
          ...need,
          delivered: {
            at: now(),
            name: input.name ?? need.what ?? '那个文件',
            bytes: typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? input.bytes : 0,
          },
        }
        // 到了:她手机上那张卡撤掉,别再让她点第二次。
        delete next.ask
        delete next.why
        needs.set(need.item_id, next)
        flush()
        return next
      }
      const next = { ...need, why: input.error ?? '传的时候出错了,没说原因' }
      needs.set(need.item_id, next)
      flush()
      return next
    },
    pending(itemId) {
      const need = needs.get(itemId)
      if (need === undefined) return undefined
      if (need.delivered !== undefined) return undefined
      if (now() - need.created_at > ttlMs) return undefined
      /*
       * 为什么还没到,从明确到最轻:
       * ① 报上来的原因(推失败、找不到文件……);
       * ② 字节在路上(电话里那条:工人直推,**没有卡要她点**);
       * ③ 卡摆着等她点 —— 但她那台手机**一直没来取过这张卡**(超过宽限期)就说实话:
       *    那条路不通(手机端太老,或者它没联网);
       * ④ 事务官一下都还没走。
       */
      const offered = need.offers.length > 0
      const tookTooLong = now() - need.created_at > DELIVERY_PENDING_GRACE_MS
      const phoneNeverCame = need.ask !== undefined && polled.get(need.device_id) === undefined && tookTooLong
      const why = need.why
        ?? (!offered
          ? DELIVERY_WHY_NOT_SENT
          : need.pushed === true
            ? DELIVERY_WHY_PUSHING
            : phoneNeverCame ? DELIVERY_WHY_PHONE_TOO_OLD : DELIVERY_WHY_WAITING_TAP)
      return {
        ...(need.what === undefined ? {} : { what: need.what }),
        why,
        // 「等你输入」只给真的只差她点一下那一种:直推的那条没有一下要她点,收不到卡的那条点也点不着。
        waitingTap: need.why === undefined && offered && need.pushed !== true && !phoneNeverCame,
      }
    },
    asksFor(deviceId) {
      prune()
      // 这台来问过 = 它认得 `/files/pending` 这条路(老手机包压根不问这一句)。
      polled.set(deviceId, now())
      const out: FileAskView[] = []
      for (const need of needs.values()) {
        if (need.device_id !== deviceId) continue
        if (need.delivered !== undefined) continue
        if (need.ask !== undefined) out.push(need.ask)
      }
      return out
    },
    list() {
      return [...needs.values()]
    },
    forget(itemId) {
      needs.delete(itemId)
      flush()
    },
  }
}
