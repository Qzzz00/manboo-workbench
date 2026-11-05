import { resolve } from 'node:path'

/** Retarget QA gets one real process; the original cwd cannot consume that allowance. */
export function decisionExecutionPolicy(originalCwd: string, retargetCwd?: string): { cwd: string; limit: number } {
  if (retargetCwd === undefined) return { cwd: originalCwd, limit: 4 }
  const cwd = resolve(retargetCwd)
  if (!cwd.startsWith('/tmp/') && !cwd.startsWith('/private/tmp/')) throw new Error('Retarget QA requires a controlled temporary cwd')
  return { cwd, limit: 1 }
}
