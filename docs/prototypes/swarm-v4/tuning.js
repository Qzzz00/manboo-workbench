const TUNING_FIELDS=[
  ['count','粒子','数量',3600,500,8000,100,'颗'],
  ['particleSize','粒子','颗粒大小',1,.3,3,.05,'×'],
  ['particleBrightness','粒子','亮度',1,0,2,.05,'×'],
  ['particleGlow','粒子','柔光强度',0,0,1,.05,''],
  ['cloudSize','光团','大小 · 0 为关闭',1,0,1.7,.05,'×'],
  ['cloudBrightness','光团','发光强度',1,0,3,.05,'×'],
  ['cloudFocus','光团','核心聚焦',1,.5,2,.05,'×'],
  ['cloudHalo','光团','外晕强度',.35,0,1,.05,'×'],
  ['cloudSpeed','光团','内部流动速度',1,0,3,.05,'×'],
  ['bodySize','运动','整体大小',1,.5,1.25,.05,'×'],
  ['spinSpeed','运动','左右自转 · 负数反向',.3,-1,1,.01,'rad/s'],
  ['drift','运动','自由漂移幅度',1,0,3,.05,'×'],
  ['workSpeed','运动','工作流动速度',1,0,3,.05,'×'],
  ['morphSpeed','运动','形变速度',1,.3,2,.05,'×'],
  ['bounce','运动','回弹强度',1,0,1.5,.05,'×'],
  ['listenResponse','交流','聆听回应幅度',1,0,2,.05,'×'],
  ['listenNod','交流','聆听点头幅度',1,0,2,.05,'×'],
  ['speechResponse','交流','说话起伏幅度',1,0,2,.05,'×'],
  ['speechSpeed','交流','模拟讲话语速',1,.5,1.6,.05,'×'],
  ['iconSize','图标','图标大小',1,.4,1.2,.05,'×'],
  ['iconDepth','图标','立体厚度',1,0,3,.05,'×'],
  ['iconFlow','图标','粒子活动速度',1,0,3,.05,'×'],
  ['sway','图标','轻摆幅度',1,0,2,.05,'×'],
  ['swaySpeed','图标','轻摆频率',1,.25,2,.05,'×'],
].map(([key,group,label,value,min,max,step,unit])=>({key:String(key),group:String(group),label:String(label),value:Number(value),min:Number(min),max:Number(max),step:Number(step),unit:String(unit)}));
const TUNING_DEFAULTS=Object.freeze(Object.fromEntries(TUNING_FIELDS.map(f=>[f.key,f.value])));
const TUNING_STORAGE_KEY='butler-swarm-v4:tuning';
function normalizeTuning(input={},base=TUNING_DEFAULTS){
  const result=/** @type {Record<string,number>} */({});
  for(const f of TUNING_FIELDS){const n=input?.[f.key];result[f.key]=typeof n==='number'&&Number.isFinite(n)?Number((Math.round(Math.max(f.min,Math.min(f.max,n))/f.step)*f.step).toFixed(4)):(base[f.key]??f.value);}
  return result;
}
function parseTuningPreset(text){
  if(typeof text!=='string'||text.length>400000)throw new Error('配置文件过大（上限 400 KB）。');
  let preset;try{preset=JSON.parse(text)}catch(_){throw new Error('不是有效的 JSON 配置文件。')}
  if(preset?.kind!=='butler-swarm-v4'||preset.version!==1||!preset.settings||typeof preset.settings!=='object'||Array.isArray(preset.settings))throw new Error('请导入从此调试台导出的 v1 配置。');
  for(const f of TUNING_FIELDS)if(Object.hasOwn(preset.settings,f.key)&&!Number.isFinite(preset.settings[f.key]))throw new Error(`「${f.label}」必须是有限数值。`);
  if(preset.svg!==undefined&&(typeof preset.svg!=='string'||preset.svg.length>262144))throw new Error('配置内的 SVG 无效或过大。');
  return {kind:'butler-swarm-v4',version:1,settings:normalizeTuning(preset.settings),svg:preset.svg||'',fill:preset.fill===true};
}
function readTuningPreset(){try{const text=localStorage.getItem(TUNING_STORAGE_KEY);return text?parseTuningPreset(text):null}catch(_){return null}}
