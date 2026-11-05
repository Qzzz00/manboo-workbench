// @vitest-environment node
import { expect, it } from 'vitest'
import { decisionExecutionPolicy } from './decisionExecutionPolicy.ts'
it('keeps the old four-call policy and limits opt-in retarget to one execution in its controlled cwd', () => {
  expect(decisionExecutionPolicy('/tmp/original')).toEqual({ cwd: '/tmp/original', limit: 4 })
  expect(decisionExecutionPolicy('/tmp/original', '/tmp/retarget')).toEqual({ cwd: '/tmp/retarget', limit: 1 })
  expect(() => decisionExecutionPolicy('/tmp/original', '/')).toThrow()
  expect(() => decisionExecutionPolicy('/tmp/original', '/Users/example')).toThrow()
})
