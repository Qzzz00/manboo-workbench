import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ButlerInbox, type ButlerInboxProps } from '../src/client/ButlerInbox.tsx'
import type { Pairing } from '../../butler-app/src/api/tokenStore.js'
import type { WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)

const isolatedWorkbench = process.env.COLLAB_1C_WORKBENCH_URL
const pairedSessionFile = process.env.COLLAB_1C_PAIRED_SESSION
const realIt = it.skipIf(isolatedWorkbench === undefined || isolatedWorkbench === '' || pairedSessionFile === undefined || pairedSessionFile === '')
const realSuggestIt = it.skipIf(isolatedWorkbench === undefined || isolatedWorkbench === '' || pairedSessionFile === undefined || pairedSessionFile === '' || process.env.COLLAB_1C_SUGGEST_ACTION !== '1')

function state(): WorkbenchState {
  return { agents: [], sessions: [], quota: {}, now: new Date().toISOString(), stale: false }
}

function RealInboxHarness({ props }: { props: ButlerInboxProps }) {
  const [draft, setDraft] = useState('')
  return <ButlerInbox {...props} draft={draft} onDraftChange={setDraft} />
}

describe('real desktop ButlerInbox → isolated workbench API', () => {
  realIt('submits the production composer to /butler/say and renders the returned screen text', async () => {
    const pairing = JSON.parse(readFileSync(pairedSessionFile!, 'utf8')) as Pairing
    let sayResponse: Record<string, unknown> | undefined
    let sayStatus: number | undefined
    const realFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${pairing.token}`)
      const response = await fetch(input, { ...init, headers })
      if (String(input).endsWith('/butler/say') && init?.method === 'POST') {
        sayStatus = response.status
        sayResponse = await response.clone().json() as Record<string, unknown>
      }
      return response
    }
    const props: ButlerInboxProps = {
      state: state(),
      baseUrl: isolatedWorkbench!,
      fetchImpl: realFetch,
      onOpenConversation() {},
      draft: '',
      onDraftChange() {},
      visible: true,
      controls: { paused: false, testRinging: false, onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {}, proposals: [] },
    }
    render(<RealInboxHarness props={props} />)
    fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: '记一下 1c 桌面真实 React 与隔离 API 联动验收' } })
    fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
    await waitFor(() => expect(sayResponse).toBeDefined(), { timeout: 15_000 })
    const say = sayResponse?.say as { screen?: unknown } | undefined
    expect(typeof say?.screen, `HTTP ${sayStatus}; response keys: ${Object.keys(sayResponse ?? {}).join(',')}`).toBe('string')
    expect(String(say?.screen)).not.toBe('')
    await waitFor(() => expect(screen.getAllByText(String(say?.screen)).length).toBeGreaterThan(0))
  }, 30_000)

  realSuggestIt('renders a model-produced suggest and applies keep through the production desktop card', async () => {
    const pairing = JSON.parse(readFileSync(pairedSessionFile!, 'utf8')) as Pairing
    const requests: { status: number; body: Record<string, unknown>; response: Record<string, unknown> }[] = []
    const realFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${pairing.token}`)
      const response = await fetch(input, { ...init, headers })
      if (String(input).endsWith('/butler/say') && init?.method === 'POST') {
        requests.push({ status: response.status, body: JSON.parse(String(init.body)) as Record<string, unknown>, response: await response.clone().json() as Record<string, unknown> })
      }
      return response
    }
    const props: ButlerInboxProps = {
      state: state(), baseUrl: isolatedWorkbench!, fetchImpl: realFetch, onOpenConversation() {}, draft: '', onDraftChange() {}, visible: true,
      controls: { paused: false, testRinging: false, onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {}, proposals: [] },
    }
    render(<RealInboxHarness props={props} />)
    const prompts = [
      '帮我整理一下那项资料工作，先不要派人，建议我让谁开始。',
      '先记下一件需要梳理的客户材料，分给谁你给我一个建议，暂时不启动。',
      '有一项还不确定怎么分工的整理工作，请先保留，并建议一个合适的负责人。',
    ]
    let suggest: Record<string, unknown> | undefined
    for (const [index, prompt] of prompts.entries()) {
      fireEvent.change(screen.getByLabelText('交给事务官一件事'), { target: { value: prompt } })
      fireEvent.click(screen.getByRole('button', { name: '交给事务官' }))
      await waitFor(() => expect(requests).toHaveLength(index + 1), { timeout: 120_000 })
      if (requests[index]?.response.suggest !== undefined) { suggest = requests[index]!.response; break }
    }
    expect(suggest, `model did not return a suggest in ${requests.length} variants`).toBeDefined()
    const suggestion = suggest!.suggest as { suggest_id: string; default_action: string }
    const originalId = ((suggest!.items as { card_id?: string }[]).find(one => typeof one.card_id === 'string'))?.card_id
    expect(typeof originalId).toBe('string')
    expect(suggestion.default_action).toBe('keep')
    const actionCount = requests.length + 1
    fireEvent.click(await screen.findByRole('button', { name: '按建议默认处理' }))
    await waitFor(() => expect(requests).toHaveLength(actionCount), { timeout: 120_000 })
    const action = requests[requests.length - 1]!
    expect(action.status).toBe(200)
    expect(action.body.ctx).toMatchObject({ suggest: { suggest_id: suggestion.suggest_id, choice: 'keep' } })
    expect((action.response.items as { card_id?: string }[])[0]?.card_id).toBe(originalId)
    expect(typeof (action.response.say as { screen?: unknown } | undefined)?.screen).toBe('string')
  }, 300_000)
})
