// UI owns local files/settings only; the controller owns the single scene clock.
class TuningPanel {
  constructor({swarm,onChange,onIcon,onPause,saved,onIntent=()=>{}}) {
    this.swarm=swarm;this.onChange=onChange;this.onIcon=onIcon;this.onPause=onPause;
    this.onIntent=onIntent;
    this.svg='';this.fill=false;this.importVersion=0;this.paused=false;
    this.panel=document.getElementById('tuningPanel');this.status=document.getElementById('tuningStatus');
    this.toggle=document.getElementById('tuningToggle');
    document.getElementById('tuningFields').innerHTML=['粒子','光团','交流','运动','图标'].map((group,index)=>`<details class="tune-group" ${index<2?'open':''}><summary><span>${group}</span><small>${TUNING_FIELDS.filter(f=>f.group===group).length} 项</small></summary>${TUNING_FIELDS.filter(f=>f.group===group).map(f=>`<div class="tune-field"><div class="tune-label"><label for="tune-${f.key}">${f.label}</label><div><input type="number" aria-label="${f.group}${f.label}数值" data-tune-number="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}"><span>${f.unit}</span></div></div><input id="tune-${f.key}" aria-label="${f.group}${f.label}" type="range" data-tune="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}"></div>`).join('')}</details>`).join('');
    this.syncInputs();
    this.toggle.addEventListener('click',()=>this.setOpen(this.panel.hidden));
    document.getElementById('closeTuning').addEventListener('click',()=>this.setOpen(false));
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!this.panel.hidden)this.setOpen(false)});
    this.panel.addEventListener('input',event=>{
      const el=/** @type {HTMLInputElement} */(event.target),key=el.dataset.tune;if(!key)return;
      const number=/** @type {HTMLInputElement} */(this.panel.querySelector(`[data-tune-number="${key}"]`));number.value=el.value;
      if(key!=='count')this.change(key,Number(el.value));
    });
    this.panel.addEventListener('change',event=>{
      const el=/** @type {HTMLInputElement} */(event.target),key=el.dataset.tuneNumber||el.dataset.tune;
      if(key)this.change(key,el.value.trim()===''?NaN:Number(el.value));
    });
    const commitNumber=event=>{const el=/** @type {HTMLInputElement} */(event.target),key=el.dataset.tuneNumber;if(key)this.change(key,el.value.trim()===''?NaN:Number(el.value))};
    this.panel.addEventListener('focusout',commitNumber);
    this.panel.addEventListener('keydown',event=>{if(event.key==='Enter'&&/** @type {HTMLElement} */(event.target).dataset.tuneNumber){event.preventDefault();commitNumber(event)}});
    document.getElementById('resetTuning').addEventListener('click',()=>{
      this.onIntent();++this.importVersion;this.svg='';this.fill=false;this.swarm.configure(TUNING_DEFAULTS);this.onChange();this.onIcon(null);this.syncInputs();
      document.getElementById('svgName').textContent='尚未导入 SVG';if(this.save())this.message('已恢复初始参数，清除自定义图标。');
    });
    document.getElementById('pauseTuning').addEventListener('click',event=>{
      this.paused=!this.paused;this.onPause(this.paused);const button=/** @type {HTMLButtonElement} */(event.currentTarget);button.textContent=this.paused?'继续动画':'暂停动画';button.setAttribute('aria-pressed',String(this.paused));
    });
    document.getElementById('exportTuning').addEventListener('click',()=>this.export());
    document.getElementById('importTuning').addEventListener('click',()=>document.getElementById('presetFile').click());
    document.getElementById('chooseSVG').addEventListener('click',()=>document.getElementById('svgFile').click());
    document.getElementById('applySVGText').addEventListener('click',()=>this.importSVG(/** @type {HTMLTextAreaElement} */(document.getElementById('svgPaste')).value,'粘贴的 SVG',this.fill));
    document.getElementById('presetFile').addEventListener('change',event=>{const input=/** @type {HTMLInputElement} */(event.target);if(input.files?.[0])this.importFile(input.files[0],true);input.value=''});
    document.getElementById('svgFile').addEventListener('change',event=>{const input=/** @type {HTMLInputElement} */(event.target);if(input.files?.[0])this.importFile(input.files[0],false);input.value=''});
    document.getElementById('svgFill').addEventListener('change',event=>{const filled=/** @type {HTMLInputElement} */(event.target).checked;if(this.svg)this.importSVG(this.svg,'自定义 SVG',filled);else this.fill=filled});
    document.getElementById('previewSVG').addEventListener('click',()=>{if(this.swarm.glyphs.custom)this.onIcon(this.swarm.glyphs.custom);else this.message('先选择或拖入一个 SVG。',true)});
    const drop=document.getElementById('svgDrop');
    for(const eventName of ['dragenter','dragover'])drop.addEventListener(eventName,event=>{event.preventDefault();drop.dataset.dragging='true'});
    drop.addEventListener('dragleave',()=>{delete drop.dataset.dragging});
    drop.addEventListener('drop',event=>{event.preventDefault();delete drop.dataset.dragging;if(event.dataTransfer?.files.length===1)this.importFile(event.dataTransfer.files[0],false);else this.message('请一次拖入一个 SVG 文件。',true)});
    // Prevent file drops outside the target from navigating away and losing work.
    document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault()});
    document.addEventListener('drop',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();if(!drop.contains(/** @type {Node} */(event.target))){this.setOpen(true);this.message('请把 SVG 放到抽屉里的虚线区域。')}}});
    if(saved?.svg)this.importSVG(saved.svg,'上次的 SVG',saved.fill,false);
  }
  setOpen(open){this.panel.hidden=!open;document.documentElement.dataset.tuningOpen=String(open);this.toggle.setAttribute('aria-expanded',String(open));if(!open)this.toggle.focus();else document.getElementById('closeTuning').focus()}
  syncInputs(){for(const f of TUNING_FIELDS)for(const selector of [`[data-tune="${f.key}"]`,`[data-tune-number="${f.key}"]`]){const el=/** @type {HTMLInputElement} */(this.panel.querySelector(selector));el.value=String(this.swarm.settings[f.key])}document.getElementById('tuningCount').textContent=`${this.swarm.count.toLocaleString()} 颗`;/** @type {HTMLInputElement} */(document.getElementById('svgFill')).checked=this.fill;}
  change(key,value){if(!Number.isFinite(value)){this.syncInputs();this.message('请输入有限数值。',true);return}this.swarm.configure({[key]:value});this.onChange();this.syncInputs();const ok=this.save();if(ok)this.message(this.swarm.count>6000?'已保存 · 高粒子数量可能增加负载，卡顿时请调低。':'实时生效 · 已自动保存到本机。')}
  preset(){return {kind:'butler-swarm-v4',version:1,settings:this.swarm.settings,svg:this.svg,fill:this.fill}}
  save(){try{localStorage.setItem(TUNING_STORAGE_KEY,JSON.stringify(this.preset()));return true}catch(_){this.message('当前调整已生效，但浏览器无法保存。请导出配置留存。',true);return false}}
  message(text,error=false){this.status.textContent=text;this.status.dataset.error=String(error)}
  async importFile(file,preset){
    this.onIntent();
    const version=++this.importVersion;
    try{
      if(file.size>(preset?400000:262144))throw new Error(preset?'配置文件不能超过 400 KB。':'SVG 文件不能超过 256 KB。');
      if(!preset&&!file.name.toLowerCase().endsWith('.svg'))throw new Error('请选择 .svg 文件；不支持 PNG/JPG。');
      const text=await file.text();if(version!==this.importVersion)return;
      if(preset){
        const data=parseTuningPreset(text),result=data.svg?await sampleImportedSVG(data.svg,{fill:data.fill}):null;
        if(version!==this.importVersion)return;
        this.svg=result?.svg||'';this.fill=data.fill;this.swarm.configure(data.settings);this.onChange();this.onIcon(result?.glyph||null);this.syncInputs();
        document.getElementById('svgName').textContent=this.svg?'配置中的 SVG':'尚未导入 SVG';if(this.save())this.message('配置已导入并应用。');
      }else await this.importSVG(text,file.name,this.fill,true,version);
    }catch(error){if(version===this.importVersion)this.message(error.message||'导入失败，已保留原来的配置。',true)}
  }
  async importSVG(text,name,fill,preview=true,version=++this.importVersion){
    if(preview)this.onIntent();
    this.message('正在读取 SVG 轮廓…');
    try{
      const result=await sampleImportedSVG(text,{fill});if(version!==this.importVersion)return;
      this.svg=result.svg;this.fill=fill;this.swarm.glyphs.custom=result.glyph;if(preview)this.onIcon(result.glyph);this.syncInputs();
      document.getElementById('svgName').textContent=`${name} · ${result.glyph.length/2} 个采样点`;if(this.save())this.message(result.warnings?.length?result.warnings.join('；'):'SVG 已就绪 · 可调节图标厚度、活动与轻摆。');
    }catch(error){if(version===this.importVersion){this.syncInputs();this.message(error.message||'SVG 无法读取，已保留原图标。',true)}}
  }
  export(){
    const url=URL.createObjectURL(new Blob([JSON.stringify(this.preset(),null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='事务官-动效参数.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);this.message('已导出配置，可随时重新导入。');
  }
}
