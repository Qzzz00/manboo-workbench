// @vitest-environment node
/**
 * 替她批准(2026-10-01,卡 AP)碰的几条接缝 —— **读源头文件比对**(接缝规矩:改契约同一分支改完所有消费方):
 *
 * ① 壳的操作 `agent_approval`:壳 hello 里报了这一格、`handle` 里认这个 op;服务端按同一个名字问 `supports`、发同一个 op;
 * ② 键底下那句中文:服务端一份、电脑卡一份、手机卡一份(三个顶层目录互不 import),三处必须一字不差;
 * ③ 8791 新口 `POST /sessions/approval/read`:中转白名单放了它(手机在外面要用),服务端真有这条路。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPROVAL_DOES_TEXT } from '../src/server/approvalKeys.ts'

const ROOT = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

describe('替她批准的接缝(卡 AP)', () => {
  it('① 壳与服务端认的是同一个 op', () => {
    const shell = read('workbench-app/Sources/HelperSocket.swift')
    const caps = shell.slice(shell.indexOf('"caps": ['), shell.indexOf(']]', shell.indexOf('"caps": [')))
    expect(caps).toContain('"agent_approval"')
    expect(shell).toContain('case "agent_approval":')
    /*
     * ★ 2026-10-02(卡「引擎接线与删复制品」):服务端这一半搬了家 ——
     * `sessionAnswer.createWindowAnswerHand` 那六只手删了,看 / 按权限弹框现在在
     * **窗口适配器一处**(`engine/adapters/window.ts`:`can('agent_approval')` 问本事、
     * `op: 'agent_approval'` 发那个 op)。`index.ts` 那一半不再按名字问某一件本事,
     * 而是把整张 `supports` 原样接进适配器 —— 所以这一条改成比这两处。
     */
    expect(read('workbench-plugin/src/index.ts')).toContain(`supports: cap => helper.supports?.(cap) ?? false`)
    const adapter = read('workbench-plugin/src/server/engine/adapters/window.ts')
    expect(adapter).toContain(`can('agent_approval')`)
    expect(adapter).toContain(`op: 'agent_approval'`)
  })

  it('② 键底下那句中文三处一字不差', () => {
    const captions = (text: string): string | undefined => /once: '([^']+)',\s*deny: '([^']+)'/.exec(text)?.slice(1).join('|')
    const server = `${APPROVAL_DOES_TEXT.once}|${APPROVAL_DOES_TEXT.deny}`
    expect(captions(read('workbench-plugin/src/client/SessionAsk.tsx'))).toBe(server)
    expect(captions(read('butler-app/src/asks/AskCards.tsx'))).toBe(server)
  })

  it('③ 手机在外面读得到弹窗上的键:中转白名单有这一条,服务端真有这条路', () => {
    expect(read('channel-worker/src/rpc.ts')).toContain(`{ method: 'POST', path: '/sessions/approval/read' }`)
    expect(read('workbench-plugin/src/server/http.ts')).toContain(`path === '/sessions/approval/read'`)
    expect(read('butler-app/src/asks/asksApi.ts')).toContain(`'/sessions/approval/read'`)
  })
})
