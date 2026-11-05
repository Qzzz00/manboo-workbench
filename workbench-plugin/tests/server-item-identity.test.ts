// @vitest-environment node
/**
 * 「又交代一句」落卡(2026-09-25 卡 N 的落卡那一半,`server/itemIdentity.ts`;
 * 入口去重 sameItemFor 与问进度尾巴 2026-10-29 删规矩第一批随旧路删除,A#24)。
 */
import { describe, expect, it } from 'vitest'
import { appendSaid } from '../src/server/itemIdentity.ts'

describe('他又交代的一句记进那张卡', () => {
  it('不改原来的描述,带时刻追加一行', () => {
    const at = new Date(2026, 8, 25, 15, 40)
    expect(appendSaid('负责:Claude\n不阻塞', '让 Claude 把额度显示修一下', at)).toBe('负责:Claude\n不阻塞\n他 09-25 15:40 又交代:「让 Claude 把额度显示修一下」')
    expect(appendSaid(undefined, '修一下', at)).toBe('他 09-25 15:40 又交代:「修一下」')
  })
})
