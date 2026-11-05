(() => {
  const root=document.documentElement,stage=document.querySelector('.workspace');
  const canvas=/** @type {HTMLCanvasElement} */(document.getElementById('particleOrb'));
  const saved=readTuningPreset(),glyphs=sampleGlyphs(),swarm=new SwarmV4(saved?.settings.count,glyphs),renderer=new SwarmRenderer(canvas,swarm),tasks=new TaskScene();
  if(saved)swarm.configure(saved.settings);
  root.dataset.particleCount=String(swarm.count);
  const layout=new Spring(0,85,16),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const response=document.getElementById('response'),active=document.getElementById('activeTask'),stacks=document.getElementById('taskStacks');
  const stackIndex={confirmation:0,completed:0,failed:0},opened=new Set();
  const taskCount=document.createElement('p');taskCount.id='taskCount';taskCount.setAttribute('aria-live','polite');document.getElementById('stateSummary').after(taskCount);
  let frame=0,last=null,timers=[],lastLayout=-1,linkGeometry=null,flight=null,callState=null,previewPaused=false;
  let visualVersion=0,tuningPanel=null,iconPicker=null,initialized=false;
  const iconCache=new BuiltinGlyphCache();let defaultPhone=glyphs.phone;
  const labels={idle:['我在。','安静地流动，等你开口。'],listening:['嗯，我在听。','你慢慢说。'],acknowledging:['听懂了。','好，交给我。'],working:['正在为你理顺。','此刻，专注于左侧这件事。'],speaking:['有进展，想告诉你。','你的事，一件一件，放在心上。'],calling:['正在呼叫你。','此处仅演示电话形体，不会实际拨号。']};
  const names={confirmation:'待你确认',completed:'已经完成',failed:'需要重试'};
  labels.custom=['你的图形，正在流动。','拖入的 SVG · 仅在本机预览。'];
  labels.builtin=['换个模样，陪着你。','内置图标 · 仅预览，不执行实际操作。'];
  labels.expressing=['一个表情，一点心意。','粒子依然流动，表情也有呼吸。'];
  labels.speaking=['有进展，想告诉你。','向外舒展，一句一句说给你听。'];
  const htmlEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function schedule(timer){timer.started=performance.now();timer.id=setTimeout(()=>{timer.id=null;timers=timers.filter(t=>t!==timer);timer.callback()},timer.remaining);}
  function after(ms,callback){const timer={remaining:ms,callback,started:0,id:null};timers.push(timer);if(!document.hidden&&!previewPaused)schedule(timer);}
  function stopSequence(){timers.forEach(t=>{if(t.id!==null)clearTimeout(t.id)});timers=[];}
  function pauseTimers(){const now=performance.now();timers.forEach(t=>{if(t.id!==null){clearTimeout(t.id);t.id=null;t.remaining=Math.max(0,t.remaining-(now-t.started))}});}
  function resumeTimers(){timers.forEach(t=>{if(t.id===null)schedule(t)});}
  function syncColor(){
    const calling=swarm.mode==='calling';
    root.dataset.notice=calling?(callState==='failed'?'failed':'confirmation'):(tasks.notification?.status||'neutral');
    renderer.setColor(root.dataset.theme,root.dataset.notice);
    // A phone must never inherit the preceding white/blue color transition.
    if(reduced.matches||calling||previewPaused)renderer.paint(0,true);
  }
  function renderCallState(){
    const calling=swarm.mode==='calling';root.dataset.callState=calling?callState:'inactive';
    const complete=/** @type {HTMLButtonElement} */(document.querySelector('[data-result="completed"]'));complete.hidden=calling;complete.disabled=calling;
    document.querySelector('[data-result="confirmation"]').textContent=calling?'重新呼叫':'待确认';
    document.querySelector('[data-result="failed"]').textContent=calling?'未接通':'失败';
    document.getElementById('endCallPreview').hidden=!calling;
    if(calling){
      document.getElementById('stateLabel').textContent=callState==='failed'?'暂时没有接通。':labels.calling[0];
      document.getElementById('stateSummary').textContent=callState==='failed'?'可以重新呼叫，或结束这次通话预览。':labels.calling[1];
    }
  }
  function taskState(task){return task.status==='queued'?'排队 · 尚未开始':task.status==='working'?(tasks.running().includes(task)?'进行中':task.agents.some(a=>a.connection==='offline')?'Agent 离线 · 进度未更新':'等待中 · 暂未执行'):names[task.status];}
  function renderPending(){
    const list=tasks.pending(),running=tasks.running().length;
    taskCount.textContent=running?`后台处理 ${running} 件`:'';
    const section=document.getElementById('runningTasks');section.hidden=!list.length;
    if(!list.length){section.innerHTML='';return;}
    document.getElementById('runningTasks').innerHTML=`<div class="stack-heading"><span>运行与排队</span><small>${running} 运行 · ${list.filter(t=>t.status==='queued').length} 排队</small></div><div class="running-list" tabindex="0" aria-label="运行与排队列表">${list.map(task=>`<div class="running-row" data-selected="${task.id===tasks.focusedId}"><button data-focus-task="${task.id}" aria-pressed="${task.id===tasks.focusedId}"><strong title="${htmlEscape(task.title)}">${htmlEscape(task.title)}</strong><span title="${htmlEscape(task.agents.map(a=>a.step).join(' · '))}">${htmlEscape(taskState(task))}${task.id===tasks.focusedId?' · 已选中':''} · ${htmlEscape(task.agents.map(a=>a.step).join(' · '))}</span><small>${htmlEscape(task.agents.map(a=>`${a.client} / ${a.session} · 更新 ${a.updated}`).join(' · '))}</small></button>${task.status==='queued'?`<button data-start-task="${task.id}" aria-label="启动${htmlEscape(task.project)}">启动 ↗</button>`:''}</div>`).join('')||'<p class="pending-empty">暂无运行事项</p>'}</div>`;
  }
  function renderStacks(){
    renderPending();
    stacks.innerHTML=Object.entries(tasks.groups()).map(([status,list])=>{
      if(!list.length)return '';
      stackIndex[status]=Math.min(stackIndex[status],Math.max(0,list.length-1));
      const index=stackIndex[status],task=list[index],unread=list.filter(t=>t.unread).length;
      return `<section class="stack-group" data-group="${status}"><div class="stack-heading"><span>${names[status]}</span><small>${unread?unread+' 未读 · ':''}${list.length} 件</small></div>${task?`<div class="stack-deck" data-count="${list.length}"><article class="card stack-card" data-task-id="${task.id}" data-unread="${task.unread}" data-open="${opened.has(task.id)}"><h2>${task.unread?'<span class="unread-indicator"></span>':''}${htmlEscape(task.title)}</h2><p class="description">${htmlEscape(task.description)}</p><p class="detail">${htmlEscape(task.detail)}</p><div class="card-footer"><span>${htmlEscape(task.project)}</span><div class="stack-controls"><button data-read-task="${task.id}" aria-label="查看${htmlEscape(task.project)}">${opened.has(task.id)?'收起':'查看'} ↗</button>${list.length>1?`<button data-next-stack="${status}" aria-label="翻阅${names[status]}的下一件">${index+1}/${list.length} ›</button>`:''}</div></div></article></div>`:'<div class="empty-stack">暂时没有这类事项</div>'}</section>`;
    }).join('');
    stacks.querySelectorAll('.stack-card[data-open="true"]').forEach(card=>{
      const button=document.createElement('button');button.className='try-task';button.setAttribute('data-start-task',card.getAttribute('data-task-id'));button.setAttribute('data-retry','true');button.textContent='重新演示处理这件事 ↗';card.appendChild(button);
    });
  }
  function renderActive(){
    linkGeometry=null;
    const task=tasks.tasks.find(t=>t.id===tasks.focusedId);active.inert=!task;active.setAttribute('aria-hidden',String(!task));
    if(!task){
      if(!reduced.matches&&!previewPaused&&!document.hidden&&layout.value>.005){active.dataset.exiting='true';return;}
      active.innerHTML='';delete active.dataset.exiting;layout.snap(0);paintLayout();return;
    }
    delete active.dataset.exiting;
    active.innerHTML=`<div class="active-eyebrow">${task.status==='queued'?'拟执行事项':'当前聚焦事项'}</div><article class="card active-card"><div class="card-head"><span>${htmlEscape(task.project)}</span><span>${htmlEscape(taskState(task))}</span></div><h2>${htmlEscape(task.title)}</h2><p>${htmlEscape(task.description)}</p>${['working','queued'].includes(task.status)?`<div class="task-steps">${task.agents.map(agent=>`<div class="agent-step"><span>${htmlEscape(agent.client)} / ${htmlEscape(agent.session)}</span><div class="task-step ${agent.connection==='online'&&agent.state==='running'?'current':''}">${htmlEscape(agent.step)}</div><small>${agent.connection==='offline'?'Agent 离线 · 最后进度未更新':agent.state==='waiting'?'等待中':task.status==='queued'?'尚未开始':'最近更新'} · ${htmlEscape(agent.updated)}</small></div>`).join('')}</div>`:`<p class="result-detail">${htmlEscape(task.detail)}</p>`}<div class="active-meta">本地模拟 · ${task.agents.length} 位执行者 <button data-close-focus>收起</button>${task.status==='queued'?`<button data-start-task="${task.id}">启动 ↗</button>`:''}</div></article>`;
    if(reduced.matches||previewPaused){layout.snap(1);paintLayout();}
  }
  async function prepareModeGlyph(mode,version){
    const slot=mode==='calling'?'phone':swarm.expression;
    const id=mode==='calling'?'phone':({smile:'mood-smile',happy:'mood-happy',wink:'mood-wink'})[slot];
    if(!id)return;
    try{
      const result=await iconCache.get(id);if(version!==visualVersion||swarm.mode!==mode)return;
      glyphs[slot]=result.glyph;
      if(mode==='calling'){defaultPhone=result.glyph;swarm.activeIcon=result.glyph;}
      root.dataset.iconStyle=result.glyph.solid?'filled':'outline';
      document.getElementById('stateSummary').textContent=result.glyph.solid?(mode==='calling'?'面状电话 · 本地预览，不会实际拨号。':'面状粒子体 · 封闭镂空随形发光，开放间隙保持通透。'):'线框兼容预览 · 图案保持活动。';
      if(reduced.matches||previewPaused){swarm.step(0,true);renderer.paint(0,true);}
    }catch(error){if(version===visualVersion)document.getElementById('stateSummary').textContent='面状采样暂不可用，保留轮廓预览。';}
  }
  function setMode(mode,manual=true,selectedIcon=null,preserveFocus=false){
    if(typeof mode!=='string'||!Object.hasOwn(labels,mode))return false;if(manual)stopSequence();
    if(mode==='idle'&&!preserveFocus){tasks.clearFocus();opened.clear();renderActive();renderStacks();}
    if(mode==='acknowledging'&&!tasks.focusedId){const candidate=tasks.pending().find(t=>t.status==='queued');if(candidate)tasks.focus(candidate.id);renderActive();renderStacks();}
    if(mode==='working'){
      if(!tasks.focusedId){const running=tasks.running()[0];if(running)tasks.focus(running.id);else if(!tasks.pending().some(t=>t.status==='working'))tasks.start('mobile');}
      const task=tasks.tasks.find(t=>t.id===tasks.focusedId);
      if(!task||!tasks.running().includes(task)){response.textContent='请先启动排队事项，或选择正在运行的事项。';return false;}
      renderActive();renderStacks();syncColor();
    }
    ++visualVersion;if(initialized&&tuningPanel)++tuningPanel.importVersion;iconPicker?.clear();delete root.dataset.iconId;delete root.dataset.iconStyle;
    const wasCalling=swarm.mode==='calling';callState=mode==='calling'?'ringing':null;
    swarm.setMode(mode);root.dataset.mode=mode;
    document.getElementById('stateLabel').textContent=labels[mode][0];document.getElementById('stateSummary').textContent=labels[mode][1];
    renderCallState();syncColor();
    if(mode==='calling')response.textContent='正在呼叫你。（本地通话预览，不会实际拨号）';else if(wasCalling)response.textContent='通话预览已结束。';
    document.getElementById('finishListening').hidden=mode!=='listening';
    document.querySelectorAll('button[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===mode)));
    document.querySelectorAll('[data-expression]').forEach(b=>b.setAttribute('aria-pressed',String(b.getAttribute('data-expression')===swarm.expression)));
    paintDialogue();
    if(reduced.matches||previewPaused){swarm.step(0,true);layout.snap(tasks.focusedId?1:0);paintLayout();renderer.paint(0,true);}
    if(!selectedIcon&&['calling','expressing','acknowledging'].includes(mode))prepareModeGlyph(mode,visualVersion);
    return true;
  }
  async function showIcon(id){
    const entry=getBuiltinIcon(id);if(!entry)return {ok:false,error:'没有这个内置图标，请先查询目录。'};
    const version=++visualVersion;if(tuningPanel)++tuningPanel.importVersion;stopSequence();
    try{
      const result=await iconCache.get(id);if(version!==visualVersion)return {ok:false,cancelled:true};
      const phone=/^phone(?:-|$)/.test(entry.id);
      if(phone)swarm.glyphs.phone=result.glyph;else swarm.glyphs.builtin=result.glyph;
      setMode(phone?'calling':'builtin',true,id);root.dataset.iconId=entry.id;root.dataset.iconStyle=result.glyph.solid?'filled':'outline';iconPicker?.setSelected(entry.id);
      if(!phone)document.getElementById('stateLabel').textContent=entry.label;
      document.getElementById('stateSummary').textContent=`${entry.id} · ${result.glyph.solid?'面状粒子体':'线框兼容'} · 仅预览`;
      return {ok:true,id:entry.id};
    }catch(error){return {ok:false,error:error.message||'图标暂时无法预览。'};}
  }
  function paintDialogue(){
    const kind=swarm.mode,visible=kind==='listening'||kind==='speaking',indicator=document.getElementById('dialogueIndicator');indicator.hidden=!visible;
    if(!visible)return;
    const active=swarm.dialogue.active,nodding=kind==='listening'&&swarm.dialogue.nod>.15;
    indicator.dataset.active=String(active);indicator.dataset.nodding=String(nodding);
    const label=`${kind==='listening'?'模拟输入':'模拟输出'} · ${nodding?'轻轻点头':active?'讲话中':'句间停顿'}`;
    const status=document.getElementById('dialogueStatus');if(status.textContent!==label)status.textContent=label;
  }
  function start(id,retry=false){if(swarm.mode==='calling'){response.textContent='结束通话预览后，可以继续处理事项。';return;}if(!(retry?tasks.restart(id):tasks.start(id))){response.textContent='这件事项不能直接启动。请从排队列表选择，或明确重新演示。';return;}stopSequence();opened.clear();renderActive();renderStacks();syncColor();setMode('working',false);response.textContent='现在正在处理左侧这件事。结果按钮只作用于这一件。';}
  function syncFocus(){
    if(swarm.mode==='working'&&!tasks.running().some(task=>task.id===tasks.focusedId))setMode('idle',false,null,true);
    renderActive();renderStacks();
  }
  function moveResultCard(source,destination){
    if(flight){flight.node.remove();flight=null;}if(reduced.matches||previewPaused||document.hidden||!source||!destination)return;
    const from=source.getBoundingClientRect(),to=destination.getBoundingClientRect();if(!from.width||!to.width)return;
    const node=/** @type {HTMLElement} */(source.cloneNode(true));node.className='card transit-card';node.setAttribute('aria-hidden','true');node.inert=true;
    node.style.cssText=`position:fixed;left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;z-index:20;transform-origin:top left;pointer-events:none;overflow:hidden;will-change:transform,opacity`;
    document.body.appendChild(node);flight={node,from,to,spring:new Spring(0,95,16),age:0};
  }
  function animateFlight(dt){
    if(!flight)return;flight.age+=dt;const v=flight.spring.step(1,dt),{from,to,node}=flight;
    node.style.transform=`translate(${(to.left-from.left)*v}px,${(to.top-from.top)*v}px) scale(${1+(to.width/from.width-1)*v},${1+(to.height/from.height-1)*v})`;
    node.style.opacity=String(Math.max(0,1-Math.max(0,(v-.75)/.25)));
    if(flight.age>1.3){node.remove();flight=null;}
  }
  function result(status,id=tasks.focusedId){
    if(!['completed','confirmation','failed'].includes(status))return;
    if(swarm.mode==='calling'){
      if(status==='completed')return;
      callState=status==='failed'?'failed':'ringing';renderCallState();syncColor();
      response.textContent=callState==='failed'?'这次没有接通。可以重新呼叫。（本地模拟）':'正在重新呼叫你。（本地模拟）';return;
    }
    const origin=active.querySelector('.active-card');
    if(!tasks.resolve(status,id)){response.textContent='请先聚焦一件正在处理的事项。';return false;}
    stopSequence();stackIndex[status]=0;opened.delete(tasks.notification.id);renderStacks();
    moveResultCard(origin,stacks.querySelector(`[data-task-id="${tasks.notification.id}"]`));
    renderActive();syncColor();setMode('idle',false);
    response.textContent=({completed:'这件事办好了。点击右侧完成卡片，看过后恢复黑白。',confirmation:'有一个决定，想等你确认。查看只消提醒，不代替确认。',failed:'这件事遇到阻碍。看过提醒后，失败事项仍会保留。'})[status];
    return true;
  }
  function acknowledge(){stopSequence();setMode('acknowledging',false);const id=tasks.focusedId;response.textContent='听懂了，准备处理左侧事项。';if(id)after(3000,()=>start(id));}
  function demo(){
    stopSequence();setMode('listening',false);response.textContent='你在说，我在听。（本地模拟）';
    const candidate=tasks.pending().find(t=>t.id===tasks.focusedId)||tasks.pending()[0];
    if(!candidate){response.textContent='没有待处理的演示事项。可从结果卡明确重新演示。';return;}
    const id=candidate.id;
    after(2200,()=>{tasks.focus(id);setMode('acknowledging',false);renderActive();renderStacks();});
    after(5200,()=>{if(!tasks.start(id))return;renderActive();renderStacks();syncColor();setMode('working',false);response.textContent='正在把当前事项的执行步骤逐一理顺。'});
    after(10800,()=>{if(!result('completed',id))return;tasks.focus(id);renderActive();renderStacks();setMode('speaking',false);response.textContent='这件事办好了，现在向你汇报。（模拟讲话节奏）';after(4600,()=>setMode('idle',false));});
  }
  function paintLayout(){
    const value=layout.value,changed=Math.abs(value-lastLayout)>.0001;
    if(changed){root.style.setProperty('--work',String(value));lastLayout=value;}
    if(!tasks.focusedId&&value<.005){active.innerHTML='';delete active.dataset.exiting;}
    if(value<.005)return;
    if(changed||!linkGeometry){
      const bounds=stage.getBoundingClientRect(),orb=canvas.getBoundingClientRect(),card=active.getBoundingClientRect();
      linkGeometry={x:card.right-bounds.left,y:card.top+card.height*.54-bounds.top,tx:orb.left+orb.width*.24-bounds.left,ty:orb.top+orb.height*.5-bounds.top};
      const {x,y,tx,ty}=linkGeometry;document.getElementById('activeLink').setAttribute('d',`M${x},${y} C${x+45},${y} ${tx-35},${ty} ${tx},${ty}`);
    }
    const {x,y,tx,ty}=linkGeometry;
    const u=(swarm.time*.28)%1,v=1-u;
    document.getElementById('linkDot').setAttribute('cx',String(v*v*v*x+3*v*v*u*(x+45)+3*v*u*u*(tx-35)+u*u*u*tx));
    document.getElementById('linkDot').setAttribute('cy',String(v*v*v*y+3*v*v*u*y+3*v*u*u*ty+u*u*u*ty));
  }
  const profile=new URLSearchParams(location.search).has('profile'),samples=[],intervals=[];let sampleStart=null,previousSample=null,sampleMode=null,profileDone=false;
  function animate(now){
    frame=0;if(document.hidden||reduced.matches||previewPaused)return;
    const begin=performance.now(),dt=last===null?1/60:Math.min(.05,(now-last)/1000);last=now;
    swarm.step(dt);layout.step(tasks.focusedId?1:0,dt);renderer.paint(dt);paintDialogue();paintLayout();animateFlight(dt);
    if(profile&&!profileDone){
      if(sampleStart===null||sampleMode!==swarm.mode){sampleStart=now;sampleMode=swarm.mode;previousSample=null;samples.length=0;intervals.length=0;}
      if(now-sampleStart>700&&now-sampleStart<5700){samples.push(performance.now()-begin);if(previousSample!==null)intervals.push(now-previousSample);previousSample=now;}
      else if(now-sampleStart>=5700&&samples.length){const sorted=samples.slice().sort((a,b)=>a-b);document.getElementById('perfResult').textContent=JSON.stringify({mode:sampleMode,frames:samples.length,fps:1000/(intervals.reduce((a,b)=>a+b,0)/intervals.length),mean:samples.reduce((a,b)=>a+b,0)/samples.length,p95:sorted[Math.floor(sorted.length*.95)],longFrames:intervals.filter(x=>x>50).length,width:innerWidth,height:innerHeight,dpr:devicePixelRatio});profileDone=true;}
    }
    frame=requestAnimationFrame(animate);
  }
  function syncMotion(){if(document.hidden||reduced.matches||previewPaused){if(flight){flight.node.remove();flight=null;}if(!tasks.focusedId){active.innerHTML='';delete active.dataset.exiting;layout.snap(0);paintLayout();}}if(frame)cancelAnimationFrame(frame);frame=0;last=null;if(document.hidden||previewPaused)pauseTimers();else resumeTimers();root.dataset.motion=document.hidden||reduced.matches||previewPaused?'paused':'running';if(!document.hidden&&!reduced.matches&&!previewPaused)frame=requestAnimationFrame(animate);else if(!document.hidden&&!previewPaused){if(flight){flight.node.remove();flight=null;}swarm.step(0,true);layout.snap(tasks.focusedId?1:0);paintLayout();renderer.paint(0,true);}}
  document.addEventListener('click',event=>{
    const target=/** @type {Element} */(event.target),b=target.closest('button');if(!b)return;
    if(b.hasAttribute('data-mode')){if(b.getAttribute('data-mode')==='calling')swarm.glyphs.phone=defaultPhone;setMode(b.getAttribute('data-mode'));}
    if(b.hasAttribute('data-start-task'))start(b.getAttribute('data-start-task'),b.hasAttribute('data-retry'));
    if(b.hasAttribute('data-result'))result(b.getAttribute('data-result'));
    if(b.hasAttribute('data-focus-task')){stopSequence();tasks.focus(b.getAttribute('data-focus-task'));opened.clear();syncFocus();response.textContent='已聚焦这件事项，其他事项继续保留在右侧。';}
    if(b.hasAttribute('data-close-focus')){stopSequence();tasks.clearFocus();opened.clear();syncFocus();}
    if(b.hasAttribute('data-read-task')){stopSequence();const id=b.getAttribute('data-read-task');tasks.read(id);if(tasks.focusedId===id){tasks.clearFocus();opened.clear();}else{tasks.focus(id);opened.clear();opened.add(id);}syncFocus();syncColor();response.textContent='已看过提醒。事项状态没有改变。';}
    if(b.hasAttribute('data-next-stack')){const key=b.getAttribute('data-next-stack'),list=tasks.groups()[key];stackIndex[key]=(stackIndex[key]+1)%list.length;renderStacks();}
    if(b.hasAttribute('data-expression')){swarm.setExpression(b.getAttribute('data-expression'));setMode('expressing');document.querySelectorAll('[data-expression]').forEach(e=>e.setAttribute('aria-pressed',String(e===b)));if(reduced.matches||previewPaused){swarm.step(0,true);renderer.paint(0,true);}}
  });
  document.getElementById('orbButton').addEventListener('click',()=>swarm.mode==='listening'?acknowledge():setMode('listening'));
  document.getElementById('finishListening').addEventListener('click',acknowledge);
  document.getElementById('composer').addEventListener('submit',event=>{event.preventDefault();demo();});
  document.getElementById('parallelDemo').addEventListener('click',()=>{if(swarm.mode==='calling')return;stopSequence();tasks.parallelDemo();tasks.clearFocus();setMode('idle',false);response.textContent='本地并行演示：右侧可查看运行事项，或手动启动排队事项。';});
  document.getElementById('themeToggle').addEventListener('click',()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';document.getElementById('themeToggle').setAttribute('aria-label',root.dataset.theme==='dark'?'切换到浅色背景':'切换到深色背景');syncColor();});
  document.addEventListener('visibilitychange',syncMotion);reduced.addEventListener?.('change',syncMotion);
  const resize=()=>{linkGeometry=null;renderer.resize();renderer.paint(0,reduced.matches);paintLayout()};window.addEventListener('resize',resize);new ResizeObserver(resize).observe(stage);
  tuningPanel=new TuningPanel({swarm,saved,onIntent(){++visualVersion;stopSequence();iconPicker?.clear();},onChange(){root.dataset.particleCount=String(swarm.count);if(reduced.matches||previewPaused)swarm.step(0,true);renderer.paint(0,reduced.matches);},onIcon(glyph){if(glyph){swarm.glyphs.custom=glyph;setMode('custom');}else{delete swarm.glyphs.custom;++visualVersion;if(['custom','builtin','calling'].includes(swarm.mode))setMode('idle');}},onPause(paused){previewPaused=paused;syncMotion();}});
  iconPicker=new IconPicker({onSelect:showIcon});
  Object.defineProperty(window,'butlerVisual',{value:Object.freeze({listIcons:(query='',category='')=>listBuiltinIcons(query,category),showIcon,setMode(mode){if(!['idle','listening','acknowledging','working','speaking','expressing','calling'].includes(mode))return {ok:false,error:'不支持的动作状态。'};if(mode==='calling')swarm.glyphs.phone=defaultPhone;return {ok:setMode(mode)};}})});
  renderStacks();syncColor();setMode('idle',false);resize();syncMotion();root.dataset.glyphPoints=String(Object.values(glyphs).reduce((sum,points)=>sum+points.length/2,0));
  initialized=true;
  const params=new URLSearchParams(location.search);if(profile&&labels[params.get('mode')])setMode(params.get('mode'));
})();
