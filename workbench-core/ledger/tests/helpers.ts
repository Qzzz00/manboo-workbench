import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Actor } from '../index.ts'

/** 每条用例一个真的临时库文件(不 mock)。 */
export function tmpDb(name = 'ledger.sqlite'): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 可拨的钟:过期、保留窗都按它算。 */
export function clock(start = Date.UTC(2026, 9, 20, 9, 0, 0)): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

export const ALICE: Actor = { person: 'alice', device: 'alice-mac' }
export const ALICE_OLD_PHONE: Actor = { person: 'alice', device: 'alice-old-phone' }
export const BOB: Actor = { person: 'bob', device: 'bob-mac' }
export const HAND: Actor = { device: 'mac-a', family: 'claude' }

export const DAY = 24 * 60 * 60 * 1000
