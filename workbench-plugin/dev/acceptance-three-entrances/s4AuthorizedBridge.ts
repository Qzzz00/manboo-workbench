/** Opt-in QA transport guard. Only the original Swift primitive performs window I/O. */
import type { HelperRequest } from '../../src/server/helperChannel.ts'
import { dispatchMarker } from '../../src/server/dispatchReply.ts'
import { auditS4WindowQaCapture } from './s4WindowQa.ts'

export interface S4BridgeTask { id: string; title: string; project_id?: string; assignee?: string }
export function createAuthorizedS4WindowBridge(input: {
  authorized: boolean
  tasks: () => Promise<readonly S4BridgeTask[]>
  invoke: (request: HelperRequest) => Promise<unknown>
}): { handle(request: HelperRequest): Promise<unknown> } {
  let attempted = false
  let marker: string | undefined
  return {
    async handle(request) {
      if (!input.authorized) throw new Error('explicit single QA window authorization required')
      if (request.op === 'send_text') {
        if (request.index !== 0) throw new Error('QA window index mismatch')
        if (attempted) throw new Error('only one QA window send is authorized')
        const tasks = (await input.tasks()).filter(task => task.project_id === '样片' && task.title.trim() !== '' && request.text.startsWith(`【${dispatchMarker(task.id)}】${task.title}\n`))
        if (tasks.length !== 1) throw new Error('real QA task scope missing or ambiguous')
        const task = tasks[0]!
        if (task.assignee !== undefined && task.assignee !== 'claude') throw new Error('real QA task assignee mismatch')
        auditS4WindowQaCapture(request, task, true)
        // Recheck after the last await, then reserve synchronously before any reentrant invoke.
        if (attempted) throw new Error('only one QA window send is authorized')
        attempted = true
        marker = dispatchMarker(task.id)
        return await input.invoke(request)
      }
      if (request.op === 'read_reply') {
        if (!attempted) throw new Error('no QA conversation before authorized send')
        if (request.bundle_id !== 'com.anthropic.claudefordesktop' || request.index !== 0 || request.marker !== marker) throw new Error('QA read marker/target mismatch')
        return await input.invoke(request)
      }
      throw new Error(`QA bridge denies op: ${request.op}`)
    },
  }
}

/** Read the existing worker's complete-cache receipt; not a business verdict. */
export function s4OpeningCacheReady(log: string): boolean { return /开场白备好了\s*12\s*句/.test(log) }
