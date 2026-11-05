import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../src/server/apps.ts'

// 2026-09-28 新 Air 真机(Codex 在那台上查实):微信写死 `open -a WeChat2`(维护者旧机器双开改名的名字),
// 别人机器上是 WeChat.app → 点微信标签「没有第 0 个窗口」。应用名因机器而异(Codex 在这台叫 ChatGPT.app),
// 所以一律按包标识拉起,不按显示名。
describe('拉起应用一律按包标识', () => {
  it('每一条都是 open -b <包标识>', () => {
    for (const [key, cmd] of Object.entries(APP_COMMANDS)) {
      expect(cmd.slice(0, 2), key).toEqual(['open', '-b'])
      expect(cmd[2], key).toMatch(/^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+$/)
    }
  })
  it('微信是 com.tencent.xinWeChat,不再出现 WeChat2', () => {
    expect(APP_COMMANDS.wechat).toEqual(['open', '-b', 'com.tencent.xinWeChat'])
    expect(JSON.stringify(APP_COMMANDS)).not.toContain('WeChat2')
  })
  it('基础应用的包标识', () => {
    expect(APP_COMMANDS.wecom).toEqual(['open', '-b', 'com.tencent.WeWorkMac'])
    expect(APP_COMMANDS.term).toEqual(['open', '-b', 'com.apple.Terminal'])
    expect(APP_COMMANDS.calendar).toEqual(['open', '-b', 'com.apple.iCal'])
  })
})
