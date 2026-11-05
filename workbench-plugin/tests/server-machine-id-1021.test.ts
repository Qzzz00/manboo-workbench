// @vitest-environment node
/**
 * 这台 Mac 的机器 id 与本机房间名(2026-10-21,局域网主路 M2;docs/设计-局域网主路-2026-10-21.md 第二节)。
 *
 * 机器 id 是手机 / 听筒认「我配对过的就是这台」的那个数:同一个局域网里有好几台 8791 时,
 * `GET /channel/route` 回的 `mac_id` 不等于配对时记下的那个,就不算在家。所以它必须
 * **第一次用到时定下来、以后一直是它**,并发的两次第一次也只能定出一个。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MACHINE_ID_PATTERN, defaultMachineIdFile, localRoomOf, readOrCreateMachineId } from '../src/server/machineId.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-machine-id-'))
  dirs.push(dir)
  return dir
}

describe('机器 id', () => {
  it('第一次用到时生成 32 位小写十六进制,落在数据目录;第二次读回同一个', async () => {
    const file = join(scratch(), 'workbench', 'machine-id')
    const first = await readOrCreateMachineId(file)
    expect(first).toMatch(MACHINE_ID_PATTERN)
    expect(readFileSync(file, 'utf8').trim()).toBe(first)
    expect(await readOrCreateMachineId(file)).toBe(first)
    // 不是秘密,但也不给别的用户写(与 devices.json 同一个目录、同一种收法)。
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('并发的两次「第一次」只定出一个 id(不各写各的)', async () => {
    const file = join(scratch(), 'machine-id')
    const [a, b, c] = await Promise.all([readOrCreateMachineId(file), readOrCreateMachineId(file), readOrCreateMachineId(file)])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(readFileSync(file, 'utf8').trim()).toBe(a)
  })

  it('文件里的内容读不懂(被写坏了)就重新定一个 —— 坏 id 不能拿去比', async () => {
    const dir = scratch()
    const file = join(dir, 'machine-id')
    writeFileSync(file, '这不是一个 id\n', 'utf8')
    const id = await readOrCreateMachineId(file)
    expect(id).toMatch(MACHINE_ID_PATTERN)
    expect(readFileSync(file, 'utf8').trim()).toBe(id)
  })

  it('大写或带空白的老写法照认(规整成小写)', async () => {
    const file = join(scratch(), 'machine-id')
    writeFileSync(file, '  0123456789ABCDEF0123456789ABCDEF  \n', 'utf8')
    expect(await readOrCreateMachineId(file)).toBe('0123456789abcdef0123456789abcdef')
  })

  it('缺省位置与 devices.json 同一个数据目录', () => {
    expect(defaultMachineIdFile('/Users/x')).toBe('/Users/x/.dsh/workbench/machine-id')
  })
})

describe('本机房间名', () => {
  it('wb-local-<机器 id 前 8 位>', () => {
    expect(localRoomOf('3f9c0a1b22223333444455556666777a')).toBe('wb-local-3f9c0a1b')
  })
})
