/**
 * 契约文件里写的接口表(服务端 `HOST_API`)与真给小组件的那张(客户端 `userLayerHost`)一一对应(2026-10-21)。
 * 两边各一份是因为服务端引不了带 React 组件的那份;对不上就是契约文件在骗 coding agent。
 */
import { describe, expect, it } from 'vitest'
import { HOST_API } from '../src/server/userLayer.ts'
import { userLayerHost } from '../src/client/userLayerHost.ts'

describe('@workbench/host 两份对得上', () => {
  it('组与名字逐一相同', () => {
    const { contract: _contract, ...groups } = userLayerHost
    const real = Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, Object.keys(names).sort()]))
    const written = Object.fromEntries(Object.entries(HOST_API).map(([group, names]) => [group, [...names].sort()]))
    expect(written).toEqual(real)
  })
})
