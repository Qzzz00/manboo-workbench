/**
 * 工作台自己起的重活降一档跑(2026-09-25,卡 fix/call-under-load-and-name)。
 * 会议录音转码、小红书视频抽帧与本机转写,在 macOS 上一律经 `taskpolicy -c utility` 起 ——
 * 电话在打的时候不和它抢 CPU。别的平台、没有 taskpolicy 的机器原样起,一个字都不变。
 */
import { describe, expect, it } from 'vitest'
import { TASKPOLICY_BIN, lowPriorityCommand } from '../src/server/lowPriority.ts'

describe('lowPriorityCommand', () => {
  it('macOS:包一层 taskpolicy -c utility(就地 exec,pid 不变)', () => {
    expect(lowPriorityCommand('ffmpeg', ['-i', 'a.mp4', 'a.wav'], { platform: 'darwin', exists: () => true })).toEqual({
      file: TASKPOLICY_BIN,
      args: ['-c', 'utility', 'ffmpeg', '-i', 'a.mp4', 'a.wav'],
    })
  })

  it('不是 macOS:原样', () => {
    expect(lowPriorityCommand('ffmpeg', ['-i', 'a.mp4'], { platform: 'linux', exists: () => true })).toEqual({ file: 'ffmpeg', args: ['-i', 'a.mp4'] })
  })

  it('macOS 但这台上没有 taskpolicy:原样(不因为少一个工具就起不来)', () => {
    expect(lowPriorityCommand('whisper-cli', ['-f', 'a.wav'], { platform: 'darwin', exists: () => false })).toEqual({ file: 'whisper-cli', args: ['-f', 'a.wav'] })
  })

  it('不改调用方手里那份参数', () => {
    const args = ['-f', 'a.wav'] as const
    const got = lowPriorityCommand('whisper-cli', args, { platform: 'darwin', exists: () => true })
    got.args.push('--extra')
    expect(args).toEqual(['-f', 'a.wav'])
  })
})
