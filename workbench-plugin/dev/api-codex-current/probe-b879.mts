/** 有界真实模型证据：仅读自有 normal QA profile，不复制凭据，不注册/重领。 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadModelConfig, modelEndpointOf } from '../../src/server/modelConfig.ts'
import { startWorkbenchServer } from '../../src/server/http.ts'
import { createWorkbenchService } from '../../src/server/service.ts'
import { createTasksService } from '../../src/server/tasks.ts'
import { understandByModel } from '../../src/server/sayModel.ts'
const root=process.env.QA_NORMAL_ROOT, out=process.env.QA_API_OUTPUT
if (!root || !out || !resolve(root).startsWith('/tmp/api-b879-')) throw new Error('own normal QA root and output required')
mkdirSync(out,{recursive:true,mode:0o700})
const config=await loadModelConfig(join(root,'iso/home/.dsh/workbench/model.json'))
const ep=modelEndpointOf(config)
if(config.mode!=='relay'||!ep.ready) {console.log('QA_MODEL_NOT_READY');process.exit(2)}
const cases=JSON.parse(readFileSync(new URL('../acceptance-three-entrances/sentences.json',import.meta.url),'utf8')).sentences
const ids=(process.env.QA_CASES??'s4,s5,s6,s7').split(',')
const records:any[]=[]
for (const id of ids) {
 const c=cases.find((c:any)=>c.id===id)
 const text=c.bystander?.asrMixed??c.turns[0]
 const traces:any[]=[]
 const fetchImpl:typeof fetch=async(url,init)=>{
  const request=JSON.parse(String(init?.body));const begin=Date.now();const response=await fetch(url,init)
  const raw=await response.clone().json().catch(()=>({})) as any
  traces.push({request,status:response.status,ms:Date.now()-begin,model:raw.model,finish_reason:raw.choices?.[0]?.finish_reason,usage:raw.usage,content:raw.choices?.[0]?.message?.content})
  return response
 }
 const tasks=createTasksService({file:join(out,id+'-tasks.json')})
 const server=await startWorkbenchServer({port:0,service:createWorkbenchService({}),tasks,tickIntervalMs:0,heartbeatMs:0,
  model:{endpoint:async()=>ep} as never,fetchImpl})
 try {
  const request={text,client_key:'qa-b879-'+id,entrance:'phone',ctx:{in_call:true}}
  const r=await fetch(server.url+'/butler/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)})
  const body=await r.json()
  // 只重放刚收到的同一HTTP正文给生产解析器以记录解析结果；不再调用模型、不算第二次live。
  const trace=traces[0]
  const parsed=trace===undefined?undefined:await understandByModel(text,{}, {endpoint:async()=>({...ep,key:ep.key}),fetchImpl:async()=>Response.json({choices:[{finish_reason:trace.finish_reason,message:{content:trace.content}}]})})
  records.push({id,request,traces,parsed:parsed??null,status:r.status,body,cards:(await tasks.list()).tasks})
  writeFileSync(join(out,'report.json'),JSON.stringify(records,null,2),{mode:0o600})
  console.log(JSON.stringify({id,status:r.status,model:trace?.model,finish_reason:trace?.finish_reason,parsed:parsed?.items.length,apiItems:(body as any).items?.map((i:any)=>({kind:i.kind,status:i.status,title:i.title}))}))
  if(traces.some(t=>t.status===429||t.status===401)){process.exitCode=1;break}
 } finally {await server.close()}
}
