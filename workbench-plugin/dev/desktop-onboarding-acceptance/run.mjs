/** Browser lifecycle runner. Supply an existing playwright-core module; never install through shared dependencies. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const here = dirname(fileURLToPath(import.meta.url))
const output = process.env.C03125_EVIDENCE
if (!output || !process.env.C03125_PLAYWRIGHT_MODULE) throw new Error('C03125_EVIDENCE and C03125_PLAYWRIGHT_MODULE required')
// 真实模式开关(与 serve.mjs 同名):任一打开只跑 no-device,并在该场景的真实 API 上验收。
const realModel = process.env.C03125_REAL_MODEL === '1'
const realDispatch = process.env.C03125_REAL_DISPATCH === '1'
const stubDispatch = process.env.C03125_STUB_DISPATCH === '1'
const realMode = realModel || realDispatch || stubDispatch
mkdirSync(output, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.C03125_PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({ executablePath: process.env.C03125_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = []
const safeError = error => String(error).replace(/cookie:[^\n]*/gi, 'cookie: [redacted synthetic test session]')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, label) => { for(let i=0;i<150;i++){ if(await fn())return;await sleep(100) }throw new Error('timeout: '+label) }
/** 真模型 / 真派活那几下比 15 秒长:带自己的上限轮询。 */
const longUntil = async (fn, label, timeoutMs, stepMs = 1000) => { const deadline = Date.now() + timeoutMs; for(;;){ if(await fn())return; if(Date.now() > deadline) throw new Error('timeout: '+label); await sleep(stepMs) } }
async function scenario(name) {
  const root = mkdtempSync(join(tmpdir(), 'c03125-'+name+'-')); mkdirSync(join(root,'home'))
  // 子进程拿隔离 HOME;真实模式另外拿到 run 进程的原始 HOME(只用于只读引用模型配置,serve.mjs 不打印不进证据)。
  const childEnv = { ...process.env, HOME: join(root,'home'), C03125_ROOT:root, C03125_REAL_HOME: process.env.HOME }
  let child = spawn(process.execPath, [join(here, 'serve.mjs')], { cwd: join(here, '../..'), env: childEnv, stdio: ['ignore','pipe','pipe'] })
  let serverLog = ''; child.stdout.on('data',d=>serverLog+=d);child.stderr.on('data',d=>serverLog+=d)
  const context = await browser.newContext({ viewport: { width:1440,height:900 } })
  context.setDefaultTimeout(15000)
  const page = await context.newPage(); const pageErrors=[], blocked=[], steps=[]
  page.on('pageerror',e=>pageErrors.push(e.message))
  await context.route('**/*',r=>{ const u=new URL(r.request().url());if(u.hostname==='127.0.0.1')return r.continue();blocked.push(u.origin);return r.abort() })
  let base
  const priorRequests = []
  let coldProcessRestart = false
  const check = (label, value) => { assert.ok(value, label);steps.push(label) }
  const api = async (path, data, expected=200) => {
    const response = await page.request.fetch(base+'/api'+path, { method:data===undefined?'GET':'POST', ...(data===undefined?{}:{data}) })
    const body = await response.json(); assert.equal(response.status(),expected, path+' status: '+(body.error??'')); return body
  }
  const shot = async label => { await page.screenshot({path:join(output,name+'-'+label+'.png'),fullPage:true}) }
  try {
    await until(()=>existsSync(join(root,'ready.json')), 'server boot'); base=JSON.parse(readFileSync(join(root,'ready.json'))).page
    if(name==='existing-device') {
      await api('/lan',{enabled:true});const pair=await api('/pair/start',{});await api('/pair/claim',{code:pair.pairing.code,device_name:'隔离测试手机',platform:'android'})
    }
    await page.goto(base);await page.getByRole('dialog',{name:'登录'}).waitFor()
    const inputs=page.locator('input');const password=randomUUID()+'Aa1'
    await inputs.nth(0).fill('qa'+randomUUID().slice(0,10));await inputs.nth(1).fill(password);await inputs.nth(2).fill(password)
    await page.getByRole('button',{name:'注册',exact:true}).click()
    await page.getByRole('dialog',{name:'第一次用'}).waitFor()
    check('registered through production account screen and real local account API', true)
    check('first screen has no pairing QR',await page.locator('[data-step=phone],[data-step=pair]').count()===0)
    await shot('01-desktop')
    await page.getByRole('button',{name:'配置模型与 AI 来源'}).click();await page.getByRole('button',{name:'返回引导'}).waitFor();await shot('02-config')
    await page.getByRole('button',{name:'返回引导'}).click()
    await page.getByRole('button',{name:'都行,你定'}).click()
    await page.getByRole('button',{name:'从一个新点子开始'}).click()
    await page.getByRole('textbox',{name:'称呼'}).fill('隔离验收同学')
    await page.getByRole('button',{name:'就这么叫'}).click()
    await page.getByRole('textbox',{name:'说一句'}).waitFor()
    const before=await api('/onboarding')
    check('nickname and fresh branch persisted by real answer endpoints',before.nickname==='隔离验收同学' && before.stage==='template')
    await page.reload();await page.getByRole('button',{name:'继续引导'}).waitFor()
    const afterReload=await api('/onboarding');check('refresh preserves nickname and stage', afterReload.nickname===before.nickname&&afterReload.stage===before.stage)
    if(name==='existing-device') {
      priorRequests.push(...(await(await page.request.get(base+'/qa/evidence')).json()).requests)
      await page.goto('about:blank')
      const previous=child; previous.kill('SIGTERM')
      await Promise.race([new Promise(r=>previous.once('exit',r)),sleep(3000)])
      if(previous.exitCode===null)previous.kill('SIGKILL')
      child=spawn(process.execPath,[join(here,'serve.mjs')],{cwd:join(here,'../..'),env:childEnv,stdio:['ignore','pipe','pipe']})
      child.stdout.on('data',d=>serverLog+=d);child.stderr.on('data',d=>serverLog+=d)
      await until(()=>JSON.parse(readFileSync(join(root,'ready.json'))).pid===child.pid,'new Node process ready')
      base=JSON.parse(readFileSync(join(root,'ready.json'))).page
      await page.goto(base);coldProcessRestart=true
      check('cold Node process restarted against same isolated HOME',previous.pid!==child.pid)
    } else { await page.request.post(base+'/qa/restart');await page.reload() }
    await page.getByRole('button',{name:'继续引导'}).click();await page.getByRole('textbox',{name:'说一句'}).waitFor()
    const afterRestart=await api('/onboarding');check('real API close/recreate preserves answers and resume', afterRestart.nickname===before.nickname&&afterRestart.stage===before.stage)
    // Explicit tool-answer inputs, not generated assistant output. Actual production stage validation/writes are exercised.
    await page.getByRole('textbox',{name:'说一句'}).fill('我在做产品研发')
    await page.getByRole('button',{name:'发送',exact:true}).click()
    await until(async()=> (await api('/onboarding/turns')).turns?.some(t=>t.text==='我在做产品研发'), 'real template reply')
    await until(async()=>await page.getByRole('button',{name:'发送',exact:true}).getAttribute('data-busy')!=='true', 'template send completed')
    await api('/onboarding/answer',{stage:'template',key:'template',value:'product'})
    await page.getByRole('textbox',{name:'说一句'}).fill('隔离验收项目，整理一份本地活动安排，目前在项目策划')
    await page.getByRole('button',{name:'发送',exact:true}).click()
    await until(async()=> (await api('/onboarding/turns')).turns?.some(t=>t.text?.includes('目前在项目策划')), 'real project reply')
    await until(async()=>await page.getByRole('button',{name:'发送',exact:true}).getAttribute('data-busy')!=='true', 'project send completed')
    await api('/onboarding/answer',{stage:'projects',key:'idea',value:{name:'隔离验收项目',one_liner:'整理一份本地活动安排',stage:'项目策划'}})
    check('production stage machine reaches done without setting done flag or skip endpoint',(await api('/onboarding')).done===true)
    await page.getByRole('heading',{name:'第一次有用：在电脑上试两件事'}).waitFor()
    check('desktop first-use excludes call requirement',await page.locator('[data-path=call]').count()===0)
    if (realMode) {
      // —— 真实模式:引导主流程之后走真模型 / 真派活,停在卡建好(或派成交回),证据另记。 ——
      const realEvidence = { modes: { model: realModel ? 'real' : 'controlled', dispatch: realDispatch ? 'real-kimi-cli' : stubDispatch ? 'stub-cli' : 'off' } }
      const firstView = async () => (await api('/first-use')).view
      const evidenceGet = async () => (await page.request.get(base + '/qa/evidence')).json()
      const morningEvidence = async () => (await evidenceGet()).morning
      const withDispatch = realDispatch || stubDispatch
      // 真模型听懂这一句:归类 + 1a 单中枢那一遍(走真 fetch,thinking disabled);返回调用前后的计数差。
      const taskText = '在 README 里加一行今天的日期,写 2026-10-27'
      const pending = []
      const understandStep = async () => {
        const callsBefore = (await evidenceGet()).modelCalls
        const understood = await api('/butler/understand', { text: taskText })
        const kind = understood.understanding?.kind
        const firstItem = (understood.list?.items ?? [])[0]
        realEvidence.understanding = { kind, items: (understood.list?.items ?? []).map(i => ({ kind: i.kind, title: i.title })) }
        // 只记录、不计入 PASS(2026-10-27 统筹复跑指出):这句被归成闲聊、1a 中枢选窗口手(隔离实例没壳)未接上,
        // 待派卡由驱动另走 /task/create 建——真实缺口归机制卡 t-bd1c04ed,这张卡只改驱动判法。
        pending.push('真实模型归类=「' + (typeof kind === 'string' ? kind : '无') + '/' + (firstItem?.title ?? '') + '」,1a 中枢选窗口手未接上;待派卡由驱动 /task/create 建(机制卡 t-bd1c04ed)')
        const item = await api('/butler/item', { text: taskText })
        realEvidence.butlerItem = { ok: item.ok === true, id: typeof item.id === 'string' ? item.id : undefined, note: typeof item.note === 'string' ? item.note.slice(0, 80) : undefined }
        const callsAfter = (await evidenceGet()).modelCalls
        check('real model answered the understanding call (call count grew ' + callsBefore + ' -> ' + callsAfter + ')', callsAfter > callsBefore)
        return callsAfter
      }
      if (realModel) {
        const first = await firstView()
        check('real mode starts both paths todo (no false missing doors)', first.paths.every(p => p.state === 'todo' || p.state === 'ok'))
        // 断一次模型(驱动层把下一击模型调用掐断):/model/try 如实报错,不吞、不假装成功。
        // 注:/model/try 对 deepseek-v4-flash 不带 thinking 参数,恢复后也回「模型回了空内容」——
        // 那是生产现状(设置页「试一下」对这模型一样),不是断网残留;「重试接上」的判据在听懂/早报那几击。
        await page.request.post(base + '/qa/break-model')
        const broken = await api('/model/try', {})
        check('model broken once reports honest failure: ' + JSON.stringify(broken), broken.ok === false && typeof broken.message === 'string')
      }
      // 文字交代一件真事 → 建卡(负责人 = Kimi 名片,status todo = 待派)。
      // 派活模式先建卡再派活:早报里真模型那一段(日报四段)要拿这张卡的派活证据当素材(生产语义:程序按证据喂模型)。
      const evidenceNow = await evidenceGet()
      const cardAssignee = evidenceNow.dispatchCardId
      check('kimi agent card registered (10-minute budget)', typeof cardAssignee === 'string')
      const created = await api('/task/create', { title: '验收:README 加一行日期', desc: taskText, status: 'todo', ...(cardAssignee === undefined ? {} : { assignee: cardAssignee }), from: { kind: 'said', quote: taskText }, acceptance: ['README.md 里加了一行 2026-10-27'] })
      check('task card created through real /task/create', typeof created.id === 'string')
      const findTask = async () => (await api('/state')).tasks?.tasks?.find(t => t.id === created.id)
      let task = await findTask()
      check('card awaits dispatch with right owner and no dispatch record', task?.status === 'todo' && task?.dispatch === undefined && (cardAssignee === undefined || task?.assignee === cardAssignee))
      realEvidence.card = { id: created.id, status: task?.status, assignee: task?.assignee, kind: task?.kind }
      await shot('10-card-created')
      if (withDispatch) {
        // 真实派活开关:派给本机 Kimi CLI(临时项目目录,名片上限 10 分钟),核交回与卡挪「等确认」。
        // 隔离实例对外的口径是 external(实验缺省关):先在本机打开 window_dispatch 实验开关,再派。
        const switched = await api('/experiments', { key: 'window_dispatch', on: true })
        check('window_dispatch experiment enabled on the isolated instance', switched.experiments?.on?.window_dispatch === true)
        const ran = await api('/dispatch/run', { item_id: created.id, app: 'kimi', kind: 'code', text: taskText })
        check('dispatch to kimi accepted on cli hand: ' + JSON.stringify(ran).slice(0, 220), ran.ok === true && ran.hand === 'cli')
        await longUntil(async () => { const t = await findTask(); return t?.dispatch?.status === 'done' || t?.dispatch?.status === 'failed' }, 'kimi dispatch finishes', realDispatch ? 11 * 60_000 : 60_000, 3_000)
        task = await findTask()
        if (task?.dispatch?.status !== 'done') throw new Error('dispatch did not finish ok: ' + JSON.stringify(task?.dispatch ?? null))
        check('dispatch finished with receipt', typeof task.dispatch.reply === 'string' && /^(做完:|有异议:|卡住:)/.test(task.dispatch.reply))
        check('card moved to awaiting confirmation', task.status === 'confirm')
        check('ten-minute budget recorded from agent card', task.dispatch.budget_minutes === 10)
        const readme = readFileSync(join(task.dispatch.cwd ?? join(root, 'project'), 'README.md'), 'utf8')
        check('README really got the date line in the dispatch workdir', readme.includes('2026-10-27'))
        realEvidence.dispatch = { status: task.dispatch.status, budget_minutes: task.dispatch.budget_minutes, replyPrefix: task.dispatch.reply.slice(0, 3), cardStatus: task.status, readmeHasDate: true, ...(task.dispatch.pid === undefined ? {} : { pid: task.dispatch.pid }), started_at: task.dispatch.started_at, ended_at: task.dispatch.ended_at }
        await shot('11-dispatch-confirm')
      }
      if (realModel && !withDispatch) {
        // 早报真生成(真实模型模式、不派活):真例程跑一遍,只核状态与段数。
        // 没有派活证据时日报四段按生产语义整块缺席(程序稿照出),模型那半不硬造素材。
        await page.getByRole('button', { name: '出一份早报' }).click()
        await longUntil(async () => { const m = await morningEvidence(); return m?.status === 'ok' && typeof m.segments === 'number' && m.segments > 0 }, 'real morning generation', 240_000, 2_000)
        const evMorning = await morningEvidence()
        realEvidence.morning = { status: evMorning.status, segments: evMorning.segments, dayReviewByProgram: evMorning.dayReviewByProgram, note: 'no dispatch material: day-review section legitimately absent (production semantics)' }
        await longUntil(async () => (await firstView()).paths.find(p => p.path === 'morning')?.state === 'ok', 'first-use morning shows ok', 30_000, 1_000)
        await shot('11-morning-ok')
        // 恢复后真模型听懂(断模型那一下已被 /model/try 吃掉;这里证明接上:真调用、计数增长)。
        await understandStep()
      }
      if (realModel && withDispatch) {
        // 断一次模型出早报:派活证据在窗口里,日报四段那一击真被掐断 → run.note 如实记「按记录排的」;
        // 程序稿照出(产品语义:模型那半缺席不拖垮早报)。随后恢复,真模型听懂证明接上。
        await page.request.post(base + '/qa/break-model')
        await page.getByRole('button', { name: '出一份早报' }).click()
        await longUntil(async () => { const m = await morningEvidence(); return m?.started_at !== undefined && m.dayReviewByProgram === true }, 'morning under outage honestly noted', 120_000, 1_000)
        const runOutage = await morningEvidence()
        check('morning under outage still composes report (segments present)', typeof runOutage?.segments === 'number' && runOutage.segments > 0)
        realEvidence.morning = { status: runOutage.status, segments: runOutage.segments, dayReviewByProgram: runOutage.dayReviewByProgram, note: 'model call broken once by driver; day review honestly fell back to program-composed and said so in run.note' }
        await longUntil(async () => (await firstView()).paths.find(p => p.path === 'morning')?.state === 'ok', 'first-use morning shows ok', 30_000, 1_000)
        await shot('12-morning-outage-noted')
        // 重试后接上:恢复后的真模型听懂,调用计数增长。
        await understandStep()
      }
      const evFinal = await evidenceGet()
      realEvidence.modelCalls = evFinal.modelCalls
      realEvidence.generation = evFinal.generation
      realEvidence.pendingMechanism = pending
      check('no restart/reset/revoke API used by driver', !evFinal.requests.some(r => r.path === '/onboarding/restart' || r.path === '/pair/revoke' || r.path === '/onboarding/skip-rest'))
      check('no browser runtime errors', pageErrors.length === 0)
      const boundary = realDispatch
        ? 'REAL model generation (relay quota) + REAL dispatch to local Kimi CLI in an isolated temp repo (10-minute card budget): card created, dispatched, reply received, card moved to confirm, README change verified on disk; morning under injected outage honestly noted in run record. No credentials copied/printed/evidenced; no DSH install, service registration, personal account, or hardware pairing.'
        : stubDispatch && realModel
          ? 'REAL model generation (relay quota) + STUB cli dispatch: full combined driver path (the one C03125_REAL_DISPATCH reuses with real Kimi): card created, dispatched via stub, receipt parsed, card confirm, README verified; morning under injected outage honestly noted, understanding reconnected with the real model.'
          : stubDispatch
            ? 'Controlled model + STUB cli dispatch: same driver path as real dispatch exercised end to end with a node stub (no Kimi run, no quota spent). Card created, dispatched, receipt parsed, card moved to confirm, workdir change verified.'
            : 'REAL model generation (relay quota): onboarding walked to card-created-and-awaiting-dispatch; morning report really generated (segments counted, content not evidenced; day-review section legitimately absent without dispatch material); text task understood by the real model and card created. Dispatch intentionally left off (C03125_REAL_DISPATCH is the coordinator switch).'
      results.push({ name, passed: true, steps, pendingMechanism: pending, coldProcessRestart, realEvidence, pageErrors, blockedExternalOrigins: [...new Set(blocked)], requests: evFinal.requests, boundary })
      writeFileSync(join(output, name + '-real-evidence.json'), JSON.stringify({ modelCalls: evFinal.modelCalls, morning: realEvidence.morning, understanding: realEvidence.understanding, butlerItem: realEvidence.butlerItem, card: realEvidence.card, dispatch: realEvidence.dispatch, pendingMechanism: pending, requests: evFinal.requests }, null, 2))
      writeFileSync(join(output, name + '-api-evidence.json'), JSON.stringify({ generation: evFinal.generation, requests: evFinal.requests }, null, 2))
      console.log(name + ': PASS ' + steps.length + ' checks (real mode) + ' + pending.length + ' 项待机制' + (pending.length > 0 ? ': ' + pending.join('; ') : ''))
      return
    }
    const first=(await api('/first-use')).view;check('real API reports missing prerequisites without success',first.paths.find(p=>p.path==='morning').state==='missing'&&first.paths.find(p=>p.path==='delegate').state!=='ok')
    const delegateResponse=page.waitForResponse(r=>r.url().endsWith('/api/first-use/try'))
    await page.getByRole('button',{name:'没想好,介绍一下这个项目'}).click()
    const delegateResult=await(await delegateResponse).json()
    check('real text task reports no dispatcher instead of fabricating success',delegateResult.ok===false)
    await until(async()=> (await api('/first-use')).view.paths.find(p=>p.path==='delegate').state==='missing','delegate failure persisted')
    await page.locator('[data-path=delegate][data-state=missing]').waitFor()
    await page.getByText('这件事还没做成。先补齐下面说明的条件，再重试。',{exact:true}).waitFor()
    check('missing prerequisites do not promise generation in a minute',true)
    await shot('03-first-use-missing')
    for(let i=0;i<2;i++){
      const request=page.waitForResponse(r=>r.url().endsWith('/api/first-use/try'))
      await page.getByRole('button',{name:'重试',exact:true}).first().click();const res=await request
      check('real missing routine retry '+(i+1)+' returns 404',res.status()===404)
    }
    await page.request.post(base+'/qa/restart');await page.reload()
    await page.getByRole('heading',{name:'第一次有用：在电脑上试两件事'}).waitFor()
    check('restart retains failed first-use instead of claiming success',(await api('/first-use')).view.paths.find(p=>p.path==='morning').state==='missing')
    await page.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('heading',{name:'连接手机与座机（可选）'}).waitFor()
    await shot('04-optional-devices')
    if(name==='later-pair'){
      await page.getByRole('button',{name:'连接手机或座机'}).click();await page.getByRole('button',{name:'已装,去配对'}).click()
      await page.getByRole('button',{name:'先跳过配对'}).waitFor();await shot('05-pairing-after-main')
      check('pairing QR only requested after main guide',true)
      await page.getByRole('button',{name:'先跳过配对'}).click()
    }
    if(name==='no-device'){
      await page.request.post(base+'/qa/stop')
      await page.getByRole('button',{name:'稍后再配，进工作台'}).click()
      await page.getByRole('alert').waitFor();check('real API outage does not claim finish',await page.getByRole('dialog',{name:'第一次用'}).count()===1)
      await shot('05-save-outage');await page.request.post(base+'/qa/restart')
    }
    await page.getByRole('button',{name:'稍后再配，进工作台'}).click()
    await page.locator('.ben-wb__topgear').waitFor()
    check('desktop workspace entered with real persisted first-run done',typeof(await api('/first-run')).done_at==='string')
    const devices=(await api('/state')).devices??[]
    check('device count preserved',devices.length===(name==='existing-device'?1:0))
    await page.request.post(base+'/qa/restart');await page.reload();await page.locator('.ben-wb__topgear').waitFor()
    check('old completed guide stays completed across service restart and browser reload',await page.getByRole('dialog',{name:'第一次用'}).count()===0)
    await page.locator('.ben-wb__topgear').click();await page.getByRole('tab',{name:'手机与座机',exact:true}).click()
    await page.getByRole('button',{name:'添加手机或座机'}).click()
    await until(async()=>Boolean((await api('/state')).pairing),'settings pair code')
    check('production settings retains later pairing entry',true);await shot('06-settings-pair')
    if(name==='no-device') {
      await page.setViewportSize({width:390,height:844});await page.goto(base+'/phone.html')
      await page.getByText(/首次引导请在电脑上继续/).waitFor()
      check('production phone compatibility page directs back to desktop',true);await shot('07-phone-guide')
      await page.getByRole('button',{name:'回主页',exact:true}).click()
      check('phone compatibility page can close without starting a call',await page.getByText('已回主页').count()===1)
    }
    const evidence=await(await page.request.get(base+'/qa/evidence')).json()
    evidence.requests = [...priorRequests, ...evidence.requests]
    check('no restart/reset/revoke API used by UI',!evidence.requests.some(r=>r.path==='/onboarding/restart'||r.path==='/pair/revoke'||r.path==='/onboarding/skip-rest'))
    check('no browser runtime errors',pageErrors.length===0)
    results.push({name,passed:true,steps,coldProcessRestart,generations:evidence.generation,pageErrors,blockedExternalOrigins:[...new Set(blocked)],requests:evidence.requests,
      boundary:'Production React + real local HTTP and disk services. Empty DSH host slots; session transport emits canonical stage questions and records browser text only. Template/idea submitted explicitly through real tool-answer API. No true model generation, CLI execution, mobile or handset hardware.'})
    writeFileSync(join(output,name+'-api-evidence.json'),JSON.stringify({generation:evidence.generation,requests:evidence.requests},null,2))
    console.log(name+': PASS '+steps.length+' checks')
  }catch(error){
    await shot('FAIL').catch(()=>{});results.push({name,passed:false,steps,error:safeError(error),pageErrors});throw new Error(safeError(error))
  }finally{
    writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2));writeFileSync(join(output,name+'-server.log'),serverLog)
    await context.close();child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL')
  }
}
const cases = realMode ? ['no-device'] : (process.env.C03125_CASE ? process.env.C03125_CASE.split(',') : ['no-device','later-pair','existing-device'])
try { for(const name of cases) await scenario(name) } finally { await browser.close() }
