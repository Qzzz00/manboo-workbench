// Sampling is lazy and bounded. The 120 SVG strings are not 120 particle buffers.
class BuiltinGlyphCache {
  constructor(limit=12){this.limit=Math.max(1,Math.min(12,Number.isFinite(limit)?limit:12));this.ready=new Map();this.pending=new Map();}
  get size(){return this.ready.size;}
  async get(id){
    const entry=getBuiltinIcon(id);if(!entry)throw new Error('没有这个内置图标。');
    if(this.ready.has(id)){const value=this.ready.get(id);this.ready.delete(id);this.ready.set(id,value);return value;}
    if(this.pending.has(id))return this.pending.get(id);
    if(this.pending.size>=12)throw new Error('正在准备图标，请稍后再试。');
    const task=Promise.resolve().then(()=>sampleImportedSVG(entry.svg,{fill:entry.style==='filled'})).then(result=>{
      this.ready.set(id,result);while(this.ready.size>this.limit)this.ready.delete(this.ready.keys().next().value);
      return result;
    }).finally(()=>this.pending.delete(id));
    this.pending.set(id,task);return task;
  }
}

class IconPicker {
  constructor({onSelect}){
    this.onSelect=onSelect;this.page=0;this.selected='';this.version=0;
    this.search=/** @type {HTMLInputElement} */(document.getElementById('iconSearch'));
    this.category=/** @type {HTMLSelectElement} */(document.getElementById('iconCategory'));
    this.grid=document.getElementById('iconGrid');this.selection=document.getElementById('iconSelection');
    for(const category of new Set(listBuiltinIcons().map(entry=>entry.category))){const option=document.createElement('option');option.value=category;option.textContent=category;this.category.appendChild(option);}
    const filter=()=>{this.page=0;this.render()};this.search.addEventListener('input',filter);this.category.addEventListener('change',filter);
    document.getElementById('iconPrevious').addEventListener('click',()=>{this.page=Math.max(0,this.page-1);this.render()});
    document.getElementById('iconNext').addEventListener('click',()=>{this.page++;this.render()});
    this.grid.addEventListener('click',async event=>{
      const button=/** @type {Element} */(event.target).closest('button[data-builtin-icon]');if(!button)return;
      const id=button.getAttribute('data-builtin-icon'),version=++this.version;
      this.selection.textContent='正在准备图标…';
      try{const result=await this.onSelect(id);if(version!==this.version)return;if(result?.ok)this.setSelected(id);else if(!result?.cancelled)this.selection.textContent=result?.error||'预览失败，已保留原形态。';}
      catch(error){if(version===this.version)this.selection.textContent=error.message||'图标暂时无法预览。';}
    });
    this.render();
  }
  setSelected(id){this.selected=id||'';const entry=getBuiltinIcon(id);this.selection.textContent=entry?`${entry.label} · ${entry.id} · ${entry.style==='filled'?'面状粒子体':'线框兼容'} · 仅预览`:'选择图标预览 · 实心图标，全部离线可用';this.render();}
  clear(){this.version++;this.setSelected('');}
  render(){
    const matches=listBuiltinIcons(this.search.value,this.category.value),pages=Math.max(1,Math.ceil(matches.length/24));
    this.page=Math.max(0,Math.min(pages-1,this.page));this.grid.replaceChildren();
    for(const meta of matches.slice(this.page*24,this.page*24+24)){
      const entry=getBuiltinIcon(meta.id);if(!entry)continue;
      const button=document.createElement('button');button.type='button';button.dataset.builtinIcon=entry.id;button.setAttribute('aria-label',`预览${entry.label}`);button.setAttribute('aria-pressed',String(entry.id===this.selected));button.title=entry.id;
      const icon=new DOMParser().parseFromString(entry.svg,'image/svg+xml').documentElement;
      const svg=document.importNode(icon,true);svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.setAttribute('width','23');svg.setAttribute('height','23');
      button.appendChild(svg);const label=document.createElement('span');label.textContent=entry.label;button.appendChild(label);this.grid.appendChild(button);
    }
    if(!matches.length){const empty=document.createElement('p');empty.className='icon-empty';empty.textContent='没有找到图标，试试中文名称或英文 ID。';this.grid.appendChild(empty);}
    document.getElementById('iconPage').textContent=`${matches.length} 个 · ${this.page+1} / ${pages}`;
    /** @type {HTMLButtonElement} */(document.getElementById('iconPrevious')).disabled=this.page===0;
    /** @type {HTMLButtonElement} */(document.getElementById('iconNext')).disabled=this.page>=pages-1;
  }
}
