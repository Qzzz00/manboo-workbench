class TaskScene {
  constructor() {
    this.focusedId = null; this.notification = null; this.order = 10;
    this.tasks = [
      {id:'mobile', title:'把手机端的第一条链路走通。', project:'事务官 · 手机端', description:'从手机配对，到消息与结果回传。一个环节，一个环节地确认。', detail:'正在检查：配对 → 消息 → 结果回传。', status:'queued', unread:false, order:0},
      {id:'report', title:'最后一遍，交给你看。', project:'成果汇报', description:'毽球特色办学的故事已整理好，还差你对最终版本的一句确认。', detail:'演示稿已整理。查看不代表批准，确认后才进入下一步。', status:'confirmation', unread:false, order:6},
      {id:'voice', title:'选一种，愿意每天听到的声音。', project:'声音与形象', description:'两组音色方案已准备好，等你决定。', detail:'方案保持待确认；本页没有播放或修改真实音色。', status:'confirmation', unread:false, order:5},
      {id:'review', title:'今天的进展，都在这里。', project:'今日回顾', description:'已完成的事、留下的决定，以及明天值得先看一眼的重点。', detail:'回顾已整理完成。这里是本地示例，没有读取真实工作记录。', status:'completed', unread:false, order:4},
      {id:'layout', title:'给桌面，留一点呼吸。', project:'工作空间', description:'界面层级和信息密度已整理完毕。', detail:'排版与卡片分组已完成，可以随时回看。', status:'completed', unread:false, order:3},
      {id:'sync', title:'有一份结果，还没送到。', project:'结果同步', description:'连接中断，回传未成功。内容仍保留。', detail:'失败原因：模拟连接超时。看过提醒不会清掉失败状态。', status:'failed', unread:false, order:2},
      {id:'export', title:'导出停在了最后一步。', project:'文件导出', description:'目标文件暂时不可写，需要稍后重试。', detail:'失败原因：模拟文件写入失败。未对真实文件执行操作。', status:'failed', unread:false, order:1},
    ];
    this.tasks.forEach(task=>Object.assign(task,{agents:[{id:`dsh-${task.id}`,client:'DSH',session:task.project.split(' · ').pop(),connection:'online',state:task.status==='queued'?'queued':'finished',step:task.status==='queued'?'等待开始':task.detail,updated:'本地示例'}]}));
  }
  // Compatibility for old callers: this identifies focus, never the execution set.
  get activeId(){return this.focusedId;}
  focus(id){if(!this.tasks.some(t=>t.id===id))return false;this.focusedId=id;return true;}
  clearFocus(){this.focusedId=null;}
  running(){return this.tasks.filter(t=>t.status==='working'&&t.agents.some(a=>a.connection==='online'&&a.state==='running'));}
  pending(){return this.tasks.filter(t=>['working','queued'].includes(t.status));}
  updateAgent(id,agentId,patch){
    const task=this.tasks.find(t=>t.id===id),agent=task?.agents.find(a=>a.id===agentId);
    if(!agent||!patch||Object.keys(patch).some(key=>!['connection','state','step'].includes(key))||
      ('connection' in patch&&!['online','offline'].includes(patch.connection))||('state' in patch&&!['queued','running','waiting','finished'].includes(patch.state))||
      ('step' in patch&&typeof patch.step!=='string'))return false;
    Object.assign(agent,patch,{updated:new Date().toLocaleTimeString('zh-CN',{hour12:false})});return true;
  }
  parallelDemo(){
    if(!this.tasks.some(t=>t.id==='research')){
      this.tasks.push({id:'research',title:'交叉核对两份资料。',project:'资料核对',description:'两位执行者协作核对出处，汇总为同一件事项。',detail:'核对出处与整理摘要。',status:'queued',unread:false,order:0,agents:[{id:'codex-research',client:'Codex',session:'出处核对',connection:'online',state:'queued',step:'检索并核对原始出处',updated:'本地示例'},{id:'dsh-research',client:'DSH',session:'摘要整理',connection:'online',state:'queued',step:'整理交叉核对摘要',updated:'本地示例'}]},
        {id:'outline',title:'整理明天的汇报提纲。',project:'汇报提纲',description:'等待前面的资料整理好后开始。',detail:'尚未开始，等待手动启动。',status:'queued',unread:false,order:0,agents:[{id:'codex-outline',client:'Codex',session:'明日提纲',connection:'online',state:'queued',step:'等待开始',updated:'本地示例'}]});
      this.start('mobile');this.start('research');
      if(this.running().length<2){
        this.tasks.push({id:'checklist',title:'核对演示验收清单。',project:'验收清单',description:'逐项整理本地演示的验收记录。',detail:'核对页面状态与验收记录。',status:'queued',unread:false,order:0,agents:[{id:'dsh-checklist',client:'DSH',session:'演示验收',connection:'online',state:'queued',step:'核对状态切换与记录',updated:'本地示例'}]});
        this.start('checklist');
      }
    }
  }
  restart(id){
    const task=this.tasks.find(t=>t.id===id);if(!task||!['completed','confirmation','failed'].includes(task.status))return false;
    task.status='queued';return this.start(id);
  }
  start(id) {
    const task = this.tasks.find(t => t.id === id); if (!task||!['queued','working'].includes(task.status)) return false;
    if(task.status==='queued')task.agents.forEach(agent=>{agent.state='running';if(agent.step==='等待开始')agent.step=task.id==='mobile'?'检查配对与消息链路':task.detail;agent.updated=new Date().toLocaleTimeString('zh-CN',{hour12:false});});
    this.focusedId = id; task.status = 'working'; task.unread = false;
    if (this.notification?.id === id) this.notification = null;
    return true;
  }
  resolve(status,id=this.focusedId) {
    if (!['completed','confirmation','failed'].includes(status)) return false;
    const task = this.tasks.find(t => t.id === id);if(!task||task.status!=='working')return false;
    task.status = status; task.unread = true; task.order = ++this.order;
    task.detail=({completed:'本地模拟已完成，执行结果可在此回看。',confirmation:'本地模拟等待你的确认；查看不代表批准。',failed:'本地模拟连接超时，最后进度仍保留。'})[status];
    task.agents.forEach(agent=>{agent.state='finished';});
    this.notification = {id:task.id, status}; if(this.focusedId===id)this.clearFocus();return true;
  }
  read(id) {
    const task = this.tasks.find(t => t.id === id); if (!task) return false;
    task.unread = false; if (this.notification?.id === id) this.notification = null; return true;
  }
  groups() {
    return Object.fromEntries(['confirmation','completed','failed'].map(status => [status, this.tasks.filter(t => t.status === status).sort((a,b) => b.order-a.order)]));
  }
}
