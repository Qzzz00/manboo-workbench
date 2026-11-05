// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadSentences } from '../dev/acceptance-three-entrances/judge.ts'
it('真实理解预算跨请求只放行原句一次；只观察可见正文，既不复制凭据也不替换模型响应', async () => {
  const root = await mkdtemp(join(tmpdir(), 'authorized-s4-trace-'))
  try {
    const home = join(root, 'iso/home'); await mkdir(home, { recursive: true })
    const config = { root, home }
    const module = new URL('../dev/acceptance-three-entrances/s4AuthorizedTrace.mts', import.meta.url).href
    const script = `
      import {writeFileSync} from 'node:fs';
      let count=0;
      const response=new Response(JSON.stringify({choices:[{message:{content:'VISIBLE',reasoning_content:'PRIVATE_REASONING'},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
      globalThis.fetch=async()=>{count++;return response};
      await import(${JSON.stringify(module)});
      const req={method:'POST',headers:{authorization:'Bearer PRIVATE_TEST_VALUE'},body:JSON.stringify({model:'original-provider-model',messages:[{role:'user',content:${JSON.stringify('她说:「' + loadSentences().find(s => s.id === 's4')!.turns[0]! + '」')}}]})};
      let denied=0;try{await fetch('https://example.invalid/chat/completions',req)}catch{denied++}
      writeFileSync(${JSON.stringify(join(root, 'allow-s4-once'))},'once');
      const actual=await fetch('https://example.invalid/chat/completions',req);
      if(actual!==response)throw Error('response replaced');
      try{await fetch('https://example.invalid/chat/completions',req)}catch{denied++}
      console.log(JSON.stringify({count,denied}));`
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: home, PHONE_ACCEPTANCE_ROOT: root, WORKBENCH_S4_WINDOW_QA: JSON.stringify(config) } })
    expect(JSON.parse(result.stdout)).toEqual({ count: 1, denied: 2 })
    const trace = await readFile(join(root, 'live-trace.jsonl'), 'utf8')
    expect(trace).toContain('original-provider-model')
    expect(trace).toContain('VISIBLE')
    expect(trace).not.toContain('PRIVATE_TEST_VALUE')
    expect(trace).not.toContain('PRIVATE_REASONING')
    const rows = trace.trim().split('\n').map(line => JSON.parse(line))
    expect(rows.filter(row => row.kind === 'model_request')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'blocked_model')).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
