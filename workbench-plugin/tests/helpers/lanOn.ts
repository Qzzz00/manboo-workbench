/**
 * 「允许手机在局域网访问」那个开关**开着**的 app.json 桩(2026-10-01)。
 *
 * 为什么会有这个文件:2026-08-21 起 `isAllowedRemoteAddress` 额外放行 iPhone 热点网段
 * 172.20.10.0/28,于是一批用例拿 `172.20.10.x` 扮演「已配对的手机」,不开开关也过得了
 * 外层那道来源门 —— 它们真正要验的是**设备令牌**那道门。
 *
 * 2026-10-01 维护者拍板撤掉那条热点例外(网段不等于本机,同一张热点上的别人也在里面),
 * 局域网访问一律走这个开关。那些用例于是照真机的样子把开关打开,验的还是原来那道门;
 * **对未配对 / 外人的拒绝断言一条都没松**。
 *
 * 内存实现、不落盘:这里只需要「开关是开着的」这一个事实,app.json 的读写容错是
 * server-app-config.test.ts 的事。
 */
import type { AppConfig, AppConfigService } from '../../src/server/appConfig.ts'

export function lanOnConfig(initial: Partial<AppConfig> = {}): AppConfigService {
  let data: AppConfig = { lan_access: true, ...initial }
  return {
    async get() { return data },
    async set(patch) {
      data = { ...data, ...patch }
      return data
    },
  }
}

/**
 * 直接塞给 `startWorkbenchServer({ lan })` 的那一小块。
 * `lanAddress` 固定成热点网关地址,免得用例去读这台真机的网卡(拿到什么都不该影响断言)。
 */
export function lanOn(initial: Partial<AppConfig> = {}): { config: AppConfigService, lanAddress: () => string } {
  return { config: lanOnConfig(initial), lanAddress: () => '172.20.10.1' }
}
