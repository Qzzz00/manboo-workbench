/**
 * 「签票先核归属」(2026-10-03,分支 claude/device-revoke-complete;审计附证 A,
 * `docs/审计材料/2026-10-03/devices.md` 第 39 行起)。
 *
 * 洞是这样的:「我的设备」里移除一台手机,从前只撤了**账号那一个凭据体系**;本机那把
 * 局域网设备令牌一个字没动,于是那台手机回到同一个 Wi-Fi 照常用 8791,还能再签一张进房票。
 * 撤销路由现在会连本机配对一起撤(http.ts 的 `/account/devices/revoke`),而这个文件管的是
 * **另一半**:签票那一处自己再核一次「这台设备还属于这个账号吗」。
 *
 * 为什么非要在签票那儿再核一遍 —— 撤销不一定发生在这台电脑上:
 *   - 她在**另一台电脑**(或者将来的网页)上把这台手机移除了:本机 devices.json 没人通知;
 *   - 本机那一半写盘失败 / devices.json 被从备份里恢复回去了(9/4 那次事故之后这不是假想)。
 * 这两种情况下,本机配对照旧有效,只有「问一次账号的设备表」才看得出来。
 *
 * ## 判法:只在**数得出来**的时候拒
 *
 * 一条明确的合取,少一项就放行(这一条是这个文件的全部重点):
 *   ① 账号真在服务器上、而且这台电脑登录着(拿得到 `acct:<id>` 那个 scope);
 *   ② 账号的设备表**这一次真的问到了**;
 *   ③ 表里**没有**这台设备;
 *   ④ 而这台设备在**同一个账号**的表里**从前见过**(标记记在配对记录上)。
 * 四条都成立 = 它确实是被移除的那一台 → 拒,并把本机配对也当场撤掉(落盘,重启不复活)。
 *
 * 少一项就放行,而且是**明确地**放行:
 *   - 没登录 / 账号还在本机:这一层没有「归属」可核(纯局域网配对本来就合法);
 *   - 问不到(中转连不上、超时、服务器没这一版):**取不到就缺席,不编一个「它被移除了」**;
 *   - 表里没有、从前也没见过:那是一台**从来没挂到账号下**的手机 —— 扫码配对之后电脑替它
 *     领账号令牌那一步「失败一律不吵」(butler-app/src/account/phoneLogin.ts),所以这很常见,
 *     拦它就是把一批好手机踢下线。
 *
 * ## 不缓存,但不等太久
 *
 * 签票不是热路径(配对那一下、七天一次的续期、房里等不到电脑时每分钟最多一次核对、
 * 工人替手机续票),所以**不缓存** —— 一份缓存会让「刚移除、马上又签出一张票」成立,
 * 而那正是这张卡要堵的事。代价是每次签票多一次问中转,于是必须有上限:
 * {@link DEVICE_ACCOUNT_ASK_TIMEOUT_MS} 到了就当「问不到」放行(底层那条请求没有取消接口,
 * 我们只是不再等它)。家里断网时签票因此不会卡住。
 */

/** 核出「它已经不在这个账号里了」时那句话。手机把它原样显示给人看,所以要说清下一步。 */
export const DEVICE_LEFT_ACCOUNT_TEXT = '这台设备已经从账号里移除了:要再用它,在电脑上打开配对二维码,重新扫一次。'

/** 问账号设备表最多等多久。超了当「问不到」(放行),不当「被移除」。 */
export const DEVICE_ACCOUNT_ASK_TIMEOUT_MS = 2500

export interface DeviceAccountGateDeps {
  /**
   * 此刻登录的那个账号在中转设备表里的 scope(`acct:<账号 id>`)。
   * 没登录 / 账号还在本机就是 undefined —— 那时这一层整个不生效。
   */
  scope: () => Promise<string | undefined>
  /** 账号名下有哪几个 device_id。**问不到就回 undefined**(不要回空数组,那是两件事)。 */
  accountDeviceIds: () => Promise<readonly string[] | undefined>
  /** 这台设备的配对记录上记着「在哪个账号的设备表里见过」。没记过就是 undefined。 */
  markOf: (deviceId: string) => Promise<string | undefined>
  /** 记一笔「见过」。只在表里真有它时调。 */
  note: (deviceId: string, scope: string) => Promise<void>
  /** 判出「已经不在账号里」之后撤掉本机配对(落盘)。 */
  revokePairing: (deviceId: string) => Promise<void>
  timeoutMs?: number
}

export interface DeviceAccountGate {
  /** 这台设备现在还能签票吗。拒的时候带一句人话。 */
  check: (deviceId: string) => Promise<{ ok: true } | { ok: false, error: string }>
}

const PASS = { ok: true } as const

export function createDeviceAccountGate(deps: DeviceAccountGateDeps): DeviceAccountGate {
  const timeoutMs = deps.timeoutMs ?? DEVICE_ACCOUNT_ASK_TIMEOUT_MS

  /** 问一次,最多等 timeoutMs;抛了、超时了都当「问不到」。 */
  async function ask(): Promise<readonly string[] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        deps.accountDeviceIds().catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) }),
      ])
    }
    catch { return undefined }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  return {
    async check(deviceId) {
      if (deviceId === '') return PASS
      const scope = await deps.scope().catch(() => undefined)
      if (scope === undefined || scope === '') return PASS
      const ids = await ask()
      if (ids === undefined) return PASS
      if (ids.includes(deviceId)) {
        // 见过了就记一笔:**以后**它从表里消失才算得上「被移除」。
        await deps.note(deviceId, scope).catch(() => undefined)
        return PASS
      }
      const mark = await deps.markOf(deviceId).catch(() => undefined)
      if (mark !== scope) return PASS
      // 四条都成立:这就是被移除的那一台。本机配对一并作废,别留一把还能开门的钥匙。
      await deps.revokePairing(deviceId).catch(() => undefined)
      return { ok: false, error: DEVICE_LEFT_ACCOUNT_TEXT }
    },
  }
}
