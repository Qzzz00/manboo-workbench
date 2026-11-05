// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createButlerSessionOpener, type ButlerAlignDeps } from '../src/index.ts'
import { createModelService } from '../src/server/modelService.ts'
import { createDshSettingsStore } from '../src/server/dshSettingsStore.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createButlerLifecycle } from '../src/server/butlerLifecycle.ts'
import { createTasksService } from '../src/server/tasks.ts'

const dirs: string[] = []
const servers: WorkbenchServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 只替换宿主 controller 边界；被测的是产品真正的共用 opener。 */
function openerFor(controller: object, deps: ButlerAlignDeps) {
  return createButlerSessionOpener({ on: () => undefined,
    inject: (names: readonly string[], callback: (ctx: never) => void) => {
      if (names[0] === 'sessionController') callback({ sessionController: controller } as never)
    },
  } as never, () => undefined, deps)!
}

describe('共用 say：电话、返工、显式补话不能绕失败闸', () => {
  it.each(['application', 'alignment'] as const)('%s 失败时共用入口拒发，零 prompt、零新会话', async failure => {
    let prompts = 0
    let creates = 0
    const opener = openerFor({
      create: async () => { creates += 1; return { sessionId: 'qa-session' } },
      prompt: async () => { prompts += 1 },
      selectModel: async () => { throw new Error('UNKNOWN_MODEL') },
    }, {
      target: async () => {
        if (failure === 'application') throw new Error('MODEL_APPLICATION_FAILED')
        return { provider: 'workbench-own', model: 'qa-brain-b' }
      },
      selectionOf: () => ({ provider: 'workbench-own', model: 'qa-brain-a' }),
      catalogDefault: async () => undefined,
    })
    expect(await opener.say!('qa-session', 'qa-only')).toBe(false)
    expect({ prompts, creates }).toEqual({ prompts: 0, creates: 0 })
  })

  it('手工 provider 会话不被改派，原会话仍可补话', async () => {
    const selected: unknown[] = []
    const prompted: string[] = []
    const opener = openerFor({ create: async () => ({ sessionId: 'unused' }),
      prompt: async (request: { sessionId: string }) => { prompted.push(request.sessionId) },
      selectModel: async (request: unknown) => { selected.push(request) },
    }, { target: async () => ({ provider: 'workbench-own', model: 'qa-brain-b', prevModel: 'qa-brain-a' }),
      selectionOf: () => ({ provider: 'manual-provider', model: 'qa-brain-a' }), catalogDefault: async () => undefined,
    })
    expect(await opener.say!('manual-session', 'qa-only')).toBe(true)
    expect(selected).toEqual([])
    expect(prompted).toEqual(['manual-session'])
  })
})
