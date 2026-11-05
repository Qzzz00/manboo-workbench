import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.ts'

describe('readConfig:端口与上游都由环境变量定', () => {
  it('缺省 127.0.0.1:8791 → http://127.0.0.1:8790,非本机来源不转', () => {
    expect(readConfig({})).toEqual({ port: 8791, host: '127.0.0.1', upstream: 'http://127.0.0.1:8790' })
  })

  it('CORE_PORT / CORE_HOST / CORE_UPSTREAM / CORE_UPSTREAM_REMOTE / CORE_KEEP_EVENTS 照读', () => {
    expect(readConfig({
      CORE_PORT: '8793',
      CORE_HOST: '0.0.0.0',
      CORE_UPSTREAM: 'http://127.0.0.1:8791/',
      CORE_UPSTREAM_REMOTE: 'http://192.168.1.20:8790',
      CORE_KEEP_EVENTS: '500',
    })).toEqual({
      port: 8793,
      host: '0.0.0.0',
      upstream: 'http://127.0.0.1:8791',
      upstreamRemote: 'http://192.168.1.20:8790',
      keepEvents: 500,
    })
  })

  it('CORE_UPSTREAM_REMOTE=interface 照读;写成回环地址拒绝(那等于把远端请求当本机)', () => {
    expect(readConfig({ CORE_UPSTREAM_REMOTE: 'interface' }).upstreamRemote).toBe('interface')
    expect(() => readConfig({ CORE_UPSTREAM_REMOTE: 'http://127.0.0.1:8790' })).toThrow(/回环/)
    expect(() => readConfig({ CORE_UPSTREAM_REMOTE: 'http://localhost:8790' })).toThrow(/回环/)
  })

  it('坏值说人话,不悄悄退回缺省', () => {
    expect(() => readConfig({ CORE_PORT: 'abc' })).toThrow(/CORE_PORT/)
    expect(() => readConfig({ CORE_PORT: '70000' })).toThrow(/CORE_PORT/)
    expect(() => readConfig({ CORE_UPSTREAM: 'https://x' })).toThrow(/CORE_UPSTREAM/)
    expect(() => readConfig({ CORE_UPSTREAM: 'not a url' })).toThrow(/CORE_UPSTREAM/)
    expect(() => readConfig({ CORE_KEEP_EVENTS: '0' })).toThrow(/CORE_KEEP_EVENTS/)
  })

  it('上游与自己是同一个端口时拒绝启动(端口对调做了一半最容易出这个,会自己转给自己)', () => {
    expect(() => readConfig({ CORE_PORT: '8791', CORE_UPSTREAM: 'http://127.0.0.1:8791' })).toThrow(/同一个端口/)
  })
})
