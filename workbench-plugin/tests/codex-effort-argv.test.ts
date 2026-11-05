import { expect, it } from 'vitest'
import { dispatchCommand } from '../src/server/agentDispatch.ts'

it('Codex 模型和思考档同时落在真实 argv，提示词中的 high 不算参数', () => {
  const got = dispatchCommand({ family: 'codex', found: true, source: 'path', bin: '/fixture/codex' }, { prompt: '用 high 做', cwd: '/fixture/project', kind: 'code', model: 'gpt-6.1-sol', effort: 'high' })
  expect(got?.argv).toContain('gpt-6.1-sol')
  expect(got?.argv).toContain('model_reasoning_effort="high"')
  expect(got?.argv[got.argv.indexOf('model_reasoning_effort="high"') - 1]).toBe('-c')
})
