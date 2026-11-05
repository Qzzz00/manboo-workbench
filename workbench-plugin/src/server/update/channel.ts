/**
 * 更新通道落在哪、读哪一份清单(2026-10-21,内测发版底座)。两条通道的说法在 `types.ts` 的 `UPDATE_CHANNELS`。
 *
 * 选择落在 `~/.dsh/workbench/app.json` 的 `update_channel`:它是这台机器的设置(维护者那台收热修),
 * 不随账号走,也不进诊断以外的任何地方。没配过、写坏了一律当稳定版 —— 读不懂一份配置
 * 不该让体验的人收到一天四版的热修。
 */
import { loadAppConfigFile, saveAppConfigFile } from '../appConfig.ts'
import { DEFAULT_UPDATE_CHANNEL, UPDATE_CHANNEL_MANIFEST, type UpdateChannel } from './types.ts'

export interface UpdateChannelStore {
  read: () => Promise<UpdateChannel>
  write: (channel: UpdateChannel) => Promise<void>
}

/**
 * 这条通道该读的清单地址。`stableUrl` 是稳定版那一份(缺省 api.aibooo.cn/updates/latest.json,
 * 验收时由 `WORKBENCH_UPDATE_URL` 指到本地假服务器);热修那一份就在同一个目录下。
 */
export function manifestUrlOf(stableUrl: string, channel: UpdateChannel): string {
  if (channel === 'stable') return stableUrl
  return new URL(UPDATE_CHANNEL_MANIFEST[channel], stableUrl).toString()
}

/** 读写 app.json 的那一格。写的时候读整份、只改这一格、原子写回(同 diag 那颗开关)。 */
export function appJsonChannelStore(appJson: string): UpdateChannelStore {
  return {
    read: async () => (await loadAppConfigFile(appJson)).update_channel ?? DEFAULT_UPDATE_CHANNEL,
    write: async (channel) => {
      const file = await loadAppConfigFile(appJson)
      await saveAppConfigFile(appJson, { ...file, update_channel: channel })
    },
  }
}
