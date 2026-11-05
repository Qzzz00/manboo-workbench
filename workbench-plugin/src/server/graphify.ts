/**
 * Graphify 图谱(2026-10-23,卡「系统文件夹改成Graphify图谱」):「图谱」那一格嵌 graphify
 * 按项目生成的 graph.html,产物全本地、不叫模型。
 *
 * ## 真实链路(10-23 从官方源码取证,纠正卡上的旧写法)
 *
 * PyPI 官方包是 `graphifyy`(双 y)**0.1.14**,MIT。它的 console script 只有
 * install / hook / benchmark 几个登记类命令 —— **没有 `extract`,没有 `--version`,
 * 没有 `--code-only`**。无模型的本地图谱走 Python API:`detect` → `extract`(tree-sitter
 * AST,只吃代码文件;语义那一路由助理带着跑,这里根本不启动)→ `build_from_json` →
 * `cluster` → `report.generate` / `export.to_json` / `export.to_html`。
 *
 * 执行环境:`uv run --with graphifyy==0.1.14 python <流水线脚本> <项目路径> <暂存目录>`。
 * 版本钉死在 GRAPHIFY_SPEC;uv 自己解决 Python ≥3.10(系统自带 python3 是 3.9,不满足),
 * 依赖全在 uv 的隔离环境里,不碰系统 site-packages。「装上」= 先把这套环境热好
 * (uv 缺席时走 endpoints.json 的 uv_bootstrap_url 下载官方安装脚本,支持 "off" 关)。
 *
 * ## 产物落地(可回滚)
 *
 * 流水线只写 `<dir>/.staging-<jobId>/`;校验过 graph.json 真的在、能解析,才把现有
 * `<dir>/<projectId>/` 挪成 `.prev-<jobId>`、把暂存挪正 —— 任一步失败,旧图谱原样留着。
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GraphifyJobView } from '../protocol.ts'
import { DEFAULT_UV_BOOTSTRAP_URL } from './endpoints.ts'

/** 钉死的版本:升级是经过统筹的独立事项,不在这一格里随手跟。 */
const GRAPHIFY_SPEC = 'graphifyy==0.1.14'

/**
 * graphify 的 to_html 生成的 graph.html 从 unpkg 拉 vis-network —— 运行时依赖外网
 * 与本页可用,违背「本地图本地用」的边界。做法:装/建时把**钉死版本**的 vis-network
 * 下载到 `<dir>/vendor/`(下载地址默认是下面这个,`endpoints.json` 的 `viz_cdn_url`
 * 可改、写 off 可关;sha256 钉死、下载完校验不过不要),生成完把 html 里的外链换成本地
 * 相对引用(构建时拷一份进产物目录)。版本升级与 graphify 升级同一条规矩:统筹拍板。
 */
const VIS_NETWORK_VERSION = '9.1.9'
const VIZ_CDN_URL = `https://unpkg.com/vis-network@${VIS_NETWORK_VERSION}/standalone/umd/vis-network.min.js`
/** graphify 的 to_html 实际写进 html 的外链(没钉版本)——换本地引用时认的是它。 */
const VIZ_UPSTREAM_URL = 'https://unpkg.com/vis-network/standalone/umd/vis-network.min.js'
/** vis-network@9.1.9 standalone 构建的 sha256(2026-10-23 从 unpkg 实测,下载校验用)。 */
const VIS_NETWORK_SHA256 = 'f53f833ddb9bf97efe856bb0637d4fe88f39e39999c7e94a4b8afc8de8a1a2e5'

/**
 * 无模型的本地流水线(detect → AST extract → build → cluster → analyze → report/json/html)。
 * 只收代码文件:语义抽取那一路(要模型)由助理在会话里带着跑,这里不启动、不外发。
 * 每个阶段往 stdout 印一行 `GRAPHIFY_STAGE <名> <累计秒>`(服务层流转给格子的
 * 「正在生成…」,失败时也照实留在最后一个阶段上);最后一行 `GRAPHIFY_RESULT` 是统计。
 *
 * 两处对 graphify 0.1.14 的有界处理(全量节点/边一个不少,2026-10-23 统筹定,可撤回):
 * - suggest_questions 内部做**全图精确** betweenness(实测本仓 24228 节点要 ~16 分钟);
 *   大图改用 nx 的 k=200 采样近似(k 是 NetworkX 自带的估算法,图数据本身一行不删)。
 * - to_html 自带 5000 节点上限;大图走我们自己的导出(社区分页聚合概览、视口
 *   自适应布局、物理全关、点节点出侧栏),布局是近似,数据不是。两处都写进 meta,不宣称精确。
 */
export const PIPELINE_PY = `import json, os, sys, time
from pathlib import Path

import networkx as nx
from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.detect import detect
from graphify.export import to_html, to_json
from graphify.extract import collect_files, extract
from graphify.report import generate

# 大图的 betweenness 换 nx 自带的采样估算(只影响「建议问题」这一个报告辅助指标;
# 节点/边/社区照旧全量,见文件头)。阈值与 k 钉在这儿,调它要经过统筹。
BOUNDED_BC_MIN_NODES = 3000
BOUNDED_BC_K = 200
_exact_bc = nx.betweenness_centrality
def _bounded_bc(G, *args, **kwargs):
    if G.number_of_nodes() >= BOUNDED_BC_MIN_NODES and 'k' not in kwargs:
        kwargs['k'] = BOUNDED_BC_K
        kwargs.setdefault('seed', 42)
    return _exact_bc(G, *args, **kwargs)
nx.betweenness_centrality = _bounded_bc

LARGE_HTML = r"""<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>knowledge graph</title>
<script src="vis-network.min.js"></script>
<style>
body{margin:0;background:#0e0e12;color:#e8e8ec;font:12px/1.5 -apple-system,sans-serif;display:flex;height:100vh}
#net{flex:1;min-width:0}
#side{flex:none;width:300px;border-left:1px solid #26262e;padding:14px;overflow:auto;display:none;background:#131318}
#side h2{font-size:13px;margin:0 0 8px;word-break:break-all}
#side p{margin:4px 0;color:#9a9aa4;white-space:pre-wrap}
#side .nb{display:block;padding:4px 0;color:#e8c07a;word-break:break-all;text-decoration:none;cursor:pointer}
#side .nb:hover{text-decoration:underline;color:#f5d9a0}
#hud{position:fixed;left:10px;top:8px;color:#a0a0b0;font-size:11px;display:flex;align-items:center;gap:10px;background:rgba(20,20,26,.88);padding:6px 12px;border-radius:6px;border:1px solid #2e2e38;z-index:100;max-width:calc(100vw - 40px)}
#hud-text{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hud input,#hud button{flex:none}
#hud input{background:#141418;color:#eee;border:1px solid #3e3e4a;border-radius:4px;padding:3px 8px;font-size:11px;outline:none}
#hud input:focus{border-color:#f5b95f}
#hud button{background:#2a2a35;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px}
#hud button:hover{background:#3a3a48;color:#fff}
#loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#9a9aa4;font-size:12px;background:#0e0e12;z-index:80}
#tooshort{position:fixed;inset:0;display:none;align-items:center;justify-content:center;text-align:center;color:#9a9aa4;font-size:12px;background:#0e0e12;z-index:70;padding:12px}
@media (max-height:150px){#hud{padding:2px 6px;font-size:10px;gap:6px}#hud input,#hud button{font-size:10px;padding:2px 5px}}
</style></head><body>
<div id="net"></div>
<div id="side"><h2 id="s-label"></h2><p id="s-meta"></p><div id="s-links"></div></div>
<div id="hud"><button id="back-btn" style="display:none">返回概览</button><span id="hud-text"></span><input id="kw" placeholder="搜索定位节点..." /><button id="reset-btn">复位</button></div>
<div id="loading">正在载入图谱…</div>
<div id="tooshort">图区太矮,读不清 —— 点格子上的「展开」看全屏</div>
<script>
Promise.all([fetch('graph.json').then(function(r){return r.json()}),fetch('graph-layout.json').then(function(r){return r.json()})]).then(function(res){
  var g=res[0],layout=res[1];
  var pos=layout.positions,com=layout.communities,order=layout.order||[];
  var links=g.links||[];
  var deg={};
  links.forEach(function(e){deg[e.source]=(deg[e.source]||0)+1;deg[e.target]=(deg[e.target]||0)+1;});
  // 全量原始数据都在 graph.json 里,概览只是不一次全画出来:聚合与分页都是视图选择,不是数据删减。
  var members={};
  g.nodes.forEach(function(n){var c=com[n.id]===undefined?-1:com[n.id];(members[c]=members[c]||[]).push(n);});
  var cids=[];
  order.forEach(function(c){if(members[c]!==undefined&&cids.indexOf(c)===-1)cids.push(c);});
  Object.keys(members).forEach(function(k){var c=Number(k);if(cids.indexOf(c)===-1)cids.push(c);});
  // 社区名取度数最高成员的标签(派生展示名,数据本身不变)。
  var meta={};
  cids.forEach(function(c){
    var ms=members[c],top=null;
    ms.forEach(function(n){if(top===null||(deg[n.id]||0)>(deg[top.id]||0))top=n;});
    meta[c]={count:ms.length,top:top?(top.label||top.id):('Community '+c)};
  });
  var NL=String.fromCharCode(10);
  var adj={};
  links.forEach(function(e){(adj[e.source]=adj[e.source]||[]).push(e.target);(adj[e.target]=adj[e.target]||[]).push(e.source);});
  var byId={};
  g.nodes.forEach(function(n){byId[n.id]=n;});
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
  function hud(t){document.getElementById('hud-text').textContent=t;}
  var state={expanded:null,page:0};
  var net=new vis.Network(document.getElementById('net'),
    {nodes:new vis.DataSet([]),edges:new vis.DataSet([])},
    {physics:false,interaction:{hover:true,zoomSpeed:0.3},
     nodes:{shape:'dot',font:{color:'#f2f2f5',size:10,strokeWidth:0},borderWidth:1.5,
       color:{border:'#f5f5f7',background:'#dcdce2',highlight:{border:'#f5b95f',background:'#f5b95f'}},
       scaling:{min:2,max:80,label:{enabled:false}}},
     edges:{color:'rgba(190,190,200,0.30)',width:1,smooth:false,hoverWidth:0.4},
     layout:{improvedLayout:false}});
  window.__net=net;
  window.__nodeCount=g.nodes.length;
  window.__overviewCount=cids.length;
  /*LAYOUT_BEGIN*/
  // 概览布局是纯函数,机制只有一句话:**每颗社区带「名+数」两行标签,格子按标签空间给**。
  // NAMECELL=104px 宽(12 字代表名+成员数),ROWH=64px 高(点+两行标签+间隙),
  // 一屏放得下几颗就几颗(6–60),放不下就减页容翻页 —— 不把 48 颗挤进 110px 的窗。
  // 点半径随社区规模对数混合(真实分布头部 3460/第 48 名 49,ln 压缩量级差),
  // 且行内容得下「点+标签」:r ≤ 行高/2-28(点中心在半行,下面还有 28px 两行标签),底行标签底不越界、首行不被 HUD 盖。
  // (2026-10-26 两轮视觉退回的根因:旧棋盘+fit 全图让 2515 颗点在 700px 宽里每颗
  // 0.16px 起步;次轮固定 52px 格子又只给得出挤在一起的成员数。)
  var R_FLOOR=8,R_LNA=0.30,NAMECELL=104,ROWH=72,R_CAP=40;
  function capacityOf(W,H){
    var cols=Math.max(1,Math.floor(W/NAMECELL));
    var rows=Math.max(1,Math.floor(H/ROWH));
    var slots=cols*rows;
    // 给「其余社区」翻页点留一格(页数大于 1 时它必在),别让它把末行挤成两行
    var per=slots-(slots>=2?1:0);
    return Math.max(4,Math.min(60,per));
  }
  function layoutPage(items,W,H){
    var n=items.length;
    var cols=Math.max(1,Math.min(n,Math.floor(W/NAMECELL)));
    var rows=Math.ceil(n/cols);
    var cw=W/cols,ch=H/rows,cm=Math.min(cw,ch);
    var R=Math.max(R_FLOOR,Math.min(cw*0.46,ch/2-28,R_CAP));
    var maxc=items[0].count;
    var lnMax=Math.log(maxc+1);
    var out=[];
    for(var i=0;i<n;i++){
      var r=Math.max(R_FLOOR,Math.min(R,R*(R_LNA+(1-R_LNA)*Math.log(items[i].count+1)/lnMax)));
      out.push({x:(i%cols)*cw+cw/2,y:Math.floor(i/cols)*ch+ch/2,r:r});
    }
    out.cellMin=cm;
    return out;
  }
  /*LAYOUT_END*/
  // 每页容量跟着视口走(净区 = 视口 − 实测 HUD 高度;HUD 会随宽度折行,量真的,不写死)。
  var PAGES_CACHE={key:'',pages:[]};
  function pagesFor(per){
    var key=String(per);
    if(PAGES_CACHE.key===key)return PAGES_CACHE.pages;
    var pages=[];
    for(var i=0;i<cids.length;i+=per)pages.push(cids.slice(i,i+per));
    PAGES_CACHE={key:key,pages:pages};
    return pages;
  }
  function viewport(){var el=document.getElementById('net');return {w:Math.max(200,el.clientWidth),h:Math.max(40,el.clientHeight)};}
  function trunc(s){s=String(s);return s.length>16?s.slice(0,15)+'…':s;}
  // 真实渲染几何回执:用 vis 自己的世界→屏幕变换量每颗点画出来的实际像素半径,
  // 验收断言的是「渲染出来的大小与位置」,不是配置值;顺带核首行不被 HUD 盖、
  // 底行标签底不越界(净区判定的可复核形式)。
  function renderStats(nds){
    var vp=viewport();
    var p0=net.canvasToDOM({x:0,y:0}),p1=net.canvasToDOM({x:1,y:0});
    var sc=Math.sqrt((p1.x-p0.x)*(p1.x-p0.x)+(p1.y-p0.y)*(p1.y-p0.y))||1;
    var min=1e9,sum=0,labeled=0,firstTop=1e9,lastBottom=0;
    var sizes=[];
    nds.forEach(function(n){
      if(n.size===undefined)return;
      var c=net.canvasToDOM({x:n.x,y:n.y});
      var e=net.canvasToDOM({x:n.x+n.size,y:n.y});
      var rpx=Math.sqrt((e.x-c.x)*(e.x-c.x)+(e.y-c.y)*(e.y-c.y))/sc;
      if(rpx<min)min=rpx;
      sum+=rpx*rpx;
      sizes.push(n.size);
      if(n.label)labeled++;
      var top=c.y-rpx;
      var bottom=c.y+rpx+28;
      if(top<firstTop)firstTop=top;
      if(bottom>lastBottom)lastBottom=bottom;
    });
    sizes.sort(function(a,b){return a-b;});
    var coverage=Math.min(1,sum*Math.PI/Math.max(1,vp.w*vp.h));
    var hudH=document.getElementById('hud').offsetHeight;
    return {minRadiusPx:Math.round(min*10)/10,medianRadiusPx:sizes.length?Math.round(sizes[Math.floor(sizes.length/2)]*10)/10:0,labeledCount:labeled,coverage:Math.round(coverage*1000)/1000,W:vp.w,H:vp.h,hudH:hudH,firstRowTop:Math.round(firstTop*10)/10,lastLabelBottom:Math.round(lastBottom*10)/10,hudClear:firstTop>=hudH-1,bottomClear:lastBottom<=vp.h+1};
  }
  // 标签随格子尺寸走:大格给「代表名+成员数」,中格只给成员数,小格不贴字
  // (悬停 title 永远有全名;字挤在一起比没有字更难读 —— 04a 实证)。
  function comNode(c,x,y,r,labelMode){
    var m=meta[c];
    var label=labelMode==='full'?(trunc(m.top)+NL+m.count+' 个节点'):(labelMode==='count'?(m.count+' 个节点'):'');
    return {id:'c:'+c,kind:'com',cid:c,
      label:label,
      orig:m.top,title:m.top+' · '+m.count+' 个节点',count:m.count,
      x:x,y:y,size:r,group:c};
  }
  // 概览第 p 页(容量随视口):按成员数从大到小,页外聚成一颗「其余社区」翻页点。
  // HUD 带每拍实测(offsetHeight,它会随宽度折行,不写死常数);布局在净区里做、
  // 整体下移,首行不被盖、底行标签底不越界。
  // 净区连一行「点+名+数」都容不下(行高<ROWH 72px) → 不硬画:清图、出一句实话,
  // 走格子上已有的「展开全屏」入口 —— 读不清时不许假装展示了图。
  // 页内社区对之间、页内→页外的连线都是聚合计数(如实标明,不把原始边一条条铺进概览)。
  function renderPage(p){
    var vp=viewport();
    var hudEl=document.getElementById('hud');
    var band=hudEl.offsetHeight+8;
    var hEff=Math.max(40,vp.h-band);
    var per=capacityOf(vp.w,hEff);
    var pages=pagesFor(per);
    p=Math.min(p,pages.length-1);
    state.expanded=null;state.page=p;
    var bb=document.getElementById('back-btn');
    var tooShortEl=document.getElementById('tooshort');
    if(hEff<ROWH){
      bb.style.display='none';
      net.setData({nodes:new vis.DataSet([]),edges:new vis.DataSet([])});
      tooShortEl.style.display='flex';
      hud('这个高度读不清图 · 点格子的「展开」看全屏 · 搜索仍可定位全部 '+g.nodes.length+' 个节点');
      window.__overviewStats={page:p,pageCount:pages.length,perPage:per,shown:0,communities:cids.length,rawNodes:g.nodes.length,rawEdges:links.length,tooShort:true,hudH:hudEl.offsetHeight,W:vp.w,H:vp.h};
      return;
    }
    tooShortEl.style.display='none';
    bb.style.display=p>0?'':'none';
    bb.textContent='上一页';
    var pageCids=pages[p];
    var items=pageCids.map(function(c){return {cid:c,count:meta[c].count};});
    var restCount=Math.max(0,cids.length-(p+1)*per);
    var hasRest=restCount>0;
    if(hasRest){
      var restMembers=0;
      for(var ri=(p+1)*per;ri<cids.length;ri++)restMembers+=meta[cids[ri]].count;
      items.push({cid:-1,count:restMembers,rest:restCount});
    }
    var slots=layoutPage(items,vp.w,hEff);
    slots.forEach(function(s){s.y+=band;});
    var inPage={},nds=[],eds=[];
    pageCids.forEach(function(c){inPage[c]=true;});
    items.forEach(function(it,idx){
      var s=slots[idx];
      if(it.cid===-1){
        nds.push({id:'c:*',kind:'rest',
          label:'其余 '+it.rest+' 个社区 · '+it.count+' 个节点'+NL+'点我看下一页',
          orig:'其余社区',title:'其余 '+it.rest+' 个社区 · '+it.count+' 个节点',
          x:s.x,y:s.y,size:Math.min(56,Math.max(18,s.r)),
          color:{background:'rgba(120,120,130,0.35)',border:'#9a9aa4',highlight:{background:'#f5b95f',border:'#f5b95f'}},
          font:{color:'#bdbdc6'}});
      }else{
        nds.push(comNode(it.cid,s.x,s.y,s.r,'full'));
      }
    });
    var pair={},outCnt={};
    links.forEach(function(e){
      var c1=com[e.source]===undefined?-1:com[e.source],c2=com[e.target]===undefined?-1:com[e.target];
      if(c1===c2)return;
      if(inPage[c1]&&inPage[c2]){var k=c1<c2?c1+'|'+c2:c2+'|'+c1;pair[k]=(pair[k]||0)+1;}
      else if(inPage[c1]){outCnt[c1]=(outCnt[c1]||0)+1;}
      else if(inPage[c2]){outCnt[c2]=(outCnt[c2]||0)+1;}
    });
    Object.keys(pair).forEach(function(k){
      var pr=k.split('|'),n=pair[k];
      eds.push({from:'c:'+pr[0],to:'c:'+pr[1],count:n,title:n+' 条连线(聚合计数)',width:Math.min(6,1+Math.log(n)/Math.LN2)});
    });
    Object.keys(outCnt).forEach(function(c){
      var n=outCnt[c];
      eds.push({from:'c:'+c,to:'c:*',count:n,title:n+' 条连线(与页外社区的聚合计数)',width:Math.min(6,1+Math.log(n)/Math.LN2)});
    });
    net.setData({nodes:new vis.DataSet(nds),edges:new vis.DataSet(eds)});
    net.moveTo({position:{x:vp.w/2,y:vp.h/2},scale:1,animation:false});
    hud('概览 · 第 '+(p+1)+'/'+pages.length+' 页 · 每页 '+per+' 个社区(按成员数从大到小,聚合视图,全图共 '+g.nodes.length+' 节点 / '+links.length+' 边)· 点社区进入 · '+(hasRest?'点「其余社区」看下一页 · ':'')+'搜索定位全部节点');
    window.__overviewStats=Object.assign({page:p,pageCount:pages.length,perPage:per,shown:pageCids.length,communities:cids.length,rawNodes:g.nodes.length,rawEdges:links.length},renderStats(nds));
  }
  var INTRA_CAP=3000;
  // 进入社区:成员按真实坐标落位(近似布局),点大小随度数(像素恒定:世界尺寸按当前缩放反算);
  // 成员间连线最多画 INTRA_CAP 条(数据一行不少,如实写明);相邻社区仍聚合显示 ——
  // 只画与本社区连线最多的 6 个,摆在成员区右侧,出社区连线按 成员→目标社区 聚合计数。
  function renderCommunity(cid){
    state.expanded=cid;
    var bb2=document.getElementById('back-btn');
    bb2.style.display='';
    bb2.textContent='返回概览';
    var vp=viewport();
    var ms=members[cid],ids=[],mpos=[];
    var x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
    ms.forEach(function(n){
      var p=pos[n.id];
      if(!p){
        var h=0,s=String(n.id);
        for(var ci=0;ci<s.length;ci++)h=((h*31)+s.charCodeAt(ci))>>>0;
        p=[(h%700)-350,(((h>>>9)%700))-350];
      }
      mpos.push(p);ids.push(n.id);
      if(p[0]<x1)x1=p[0]; if(p[0]>x2)x2=p[0];
      if(p[1]<y1)y1=p[1]; if(p[1]>y2)y2=p[1];
    });
    if(!isFinite(x1)){x1=-200;y1=-200;x2=200;y2=200;}
    var pad=Math.max(60,0.15*Math.max(x2-x1,y2-y1));
    var nbrSet={},nds=[],eds=[];
    var intraTotal=0,intraDrawn=0,outAgg={};
    links.forEach(function(e){
      var c1=com[e.source]===undefined?-1:com[e.source],c2=com[e.target]===undefined?-1:com[e.target];
      if(c1===cid&&c2===cid){intraTotal++;if(intraDrawn<INTRA_CAP){intraDrawn++;eds.push({from:e.source,to:e.target});}return;}
      if(c1===cid&&c2!==cid){var k=e.source+'|'+c2;outAgg[k]=(outAgg[k]||0)+1;}
      else if(c2===cid&&c1!==cid){var k2=e.target+'|'+c1;outAgg[k2]=(outAgg[k2]||0)+1;}
    });
    var comOut={};
    Object.keys(outAgg).forEach(function(k){var pr=k.split('|');comOut[pr[1]]=(comOut[pr[1]]||0)+outAgg[k];});
    var nbrs=Object.keys(comOut).map(Number).sort(function(a,b){return comOut[b]-comOut[a];}).slice(0,6);
    var nx=x2+pad;
    // 视野定档:成员包围盒先算一版缩放, neighbor 列按这版缩放折回世界单位,
    // 再把 neighbor 列也算进视野 ——  neighbors 不会被挤出屏幕右边/顶边。
    var extW0=Math.max(160,(x2-x1)+2*pad),extH0=Math.max(160,(y2-y1)+2*pad);
    var sc0=Math.min(vp.w/extW0,vp.h/extH0,2.5);
    var ny=y1+120/sc0;
    var nbrRight=nx+150/sc0;
    var extW=Math.max(extW0,nbrRight-x1+pad),extH=Math.max(extH0,(nbrs.length>0?ny+(nbrs.length-1)*140/sc0+150/sc0:y2)-y1+pad);
    var sc=Math.min(vp.w/extW,vp.h/extH,2.5);
    ms.forEach(function(n,idx){
      var d=deg[n.id]||0;
      var sizePx=Math.max(3,Math.min(13,3+2.2*Math.sqrt(d)));
      nds.push({id:n.id,kind:'node',label:d>=12?(n.label||''):'',orig:(n.label||n.id),
        title:(n.label||'')+NL+((n.source_file)||''),deg:d,sf:n.source_file||'',group:cid,
        x:mpos[idx][0],y:mpos[idx][1],size:sizePx/sc});
    });
    nbrs.forEach(function(c,idx){
      nbrSet[c]=true;
      nds.push(comNode(c,nx+80/sc,ny+idx*140/sc,Math.max(14,Math.min(46,7*Math.sqrt(meta[c].count)))/sc,'full'));
    });
    Object.keys(outAgg).forEach(function(k){
      var pr=k.split('|');
      if(!nbrSet[Number(pr[1])])return;
      var n=outAgg[k];
      eds.push({from:pr[0],to:'c:'+pr[1],count:n,title:n+' 条连线(聚合计数)',width:Math.min(6,1+Math.log(n)/Math.LN2)});
    });
    net.setData({nodes:new vis.DataSet(nds),edges:new vis.DataSet(eds)});
    var cX=(x1+Math.max(x2,nbrRight))/2;
    net.moveTo({position:{x:cX,y:(y1+y2)/2},scale:sc,animation:false});
    var note=intraTotal>intraDrawn?(' · 成员间连线显示前 '+intraDrawn+' 条(全部 '+intraTotal+' 条在图数据里)'):'';
    var nbrNote=nbrs.length>0?(' · 相邻 '+nbrs.length+' 个社区仍聚合显示'):'';
    hud('社区 '+cid+' · '+meta[cid].top+' 等 '+meta[cid].count+' 个节点(成员为真实位置,近似布局)'+note+nbrNote+' · 返回概览');
  }
  function currentNode(id){return net.body.data.nodes.get(id);}
  function showSide(nid){
    var side=document.getElementById('side');
    if(!nid||!byId[nid]){side.style.display='none';return;}
    var d=currentNode(nid),raw=byId[nid];
    side.style.display='block';
    document.getElementById('s-label').textContent=(d&&d.orig)||(raw.label||nid);
    document.getElementById('s-meta').textContent='community '+((com[nid]===undefined)?'?':com[nid])+' · '+(deg[nid]||0)+' connections'+(raw.source_file?NL+raw.source_file:'');
    var html='';(adj[nid]||[]).slice(0,40).forEach(function(m){
      var t=byId[m];
      if(t){html+='<a class="nb" data-id="'+esc(m)+'">'+esc(t.label||t.id)+'</a>';}
    });
    document.getElementById('s-links').innerHTML=html||'<span class="nb" style="color:#888">(no neighbors)</span>';
  }
  // 选中任一原节点:它所在社区没展开就先展开(逐级展开的导航语义),再聚焦出信息栏。
  function selectNode(nid){
    if(!byId[nid])return;
    var c=com[nid]===undefined?-1:com[nid];
    if(state.expanded!==c)renderCommunity(c);
    net.selectNodes([nid]);
    net.focus(nid,{scale:1.2,animation:true});
    showSide(nid);
  }
  net.on('click',function(p){
    var nid=p.nodes&&p.nodes[0];
    if(nid===undefined||nid===null){showSide(null);return;}
    var item=currentNode(nid);
    if(item&&item.kind==='rest'){showSide(null);renderPage(state.page+1);return;}
    if(item&&item.kind==='com'){showSide(null);renderCommunity(item.cid);return;}
    net.selectNodes([nid]);showSide(nid);
  });
  document.getElementById('side').addEventListener('click',function(e){
    var id=e.target&&e.target.getAttribute('data-id');
    if(id){e.preventDefault();selectNode(id);}
  });
  document.getElementById('back-btn').onclick=function(){
    showSide(null);
    if(state.expanded!==null&&state.expanded!==undefined){state.expanded=null;renderPage(state.page);}
    else renderPage(Math.max(0,state.page-1));
  };
  document.getElementById('reset-btn').onclick=function(){
    if(state.expanded!==null&&state.expanded!==undefined)renderCommunity(state.expanded);
    else renderPage(state.page);
  };
  document.getElementById('kw').onkeydown=function(e){
    if(e.key==='Enter'){
      var q=this.value.trim().toLowerCase();
      if(!q)return;
      for(var i=0;i<g.nodes.length;i++){
        var d=g.nodes[i];
        if((d.label||'').toLowerCase().indexOf(q)!==-1||String(d.id).toLowerCase().indexOf(q)!==-1){selectNode(d.id);return;}
      }
      hud('没找到「'+this.value.trim()+'」(全部 '+g.nodes.length+' 个节点都搜过了)');
    }
  };
  // 格子拖大拖小、全屏弹层开窗:视口变了就按新视口重排(聚合与分页语义不变,可逆)。
  var rzT=null;
  window.addEventListener('resize',function(){
    if(rzT)clearTimeout(rzT);
    rzT=setTimeout(function(){
      if(state.expanded!==null&&state.expanded!==undefined)renderCommunity(state.expanded);
      else renderPage(state.page);
    },150);
  });
  var loadingEl=document.getElementById('loading');
  if(loadingEl)loadingEl.style.display='none';
  renderPage(0);
}).catch(function(e){
  var loadingEl2=document.getElementById('loading');
  if(loadingEl2)loadingEl2.textContent='图谱载入失败:'+e;
});
</script></body></html>
"""

def write_large_html(G, communities, out):
    # 社区棋盘布局(近似,只为浏览器可响应):社区按大小排,网格摆社区;
    # 社区内部节点用确定性伪散布(与数据无关的常数次计算,不用物理引擎)。
    # 页面本身渲染社区聚合概览:概览每社区一颗聚合点,点进去才落成员真实坐标,
    # 任何聚合都在页面内如实标明(2026-10-26,排查实证:不许再把全量点阵冒充总览)。
    order = sorted(communities.keys(), key=lambda c: -len(communities[c]))
    cols = max(1, int(len(order) ** 0.5))
    cell = 900.0
    positions, com_of = {}, {}
    for idx, cid in enumerate(order):
        members = communities[cid]
        cx, cy = (idx % cols) * cell, (idx // cols) * cell
        r = max(40.0, 16.0 * (len(members) ** 0.5))
        for j, nid in enumerate(members):
            dx = r * (0.35 + 0.65 * ((j * 37 % 101) / 101.0)) * (1 if j % 2 else -1)
            dy = r * (0.35 + 0.65 * ((j * 53 % 97) / 97.0)) * (1 if (j // 2) % 2 else -1)
            positions[nid] = [round(cx + dx, 3), round(cy + dy, 3)]
            com_of[nid] = cid
    (out / 'graph.html').write_text(LARGE_HTML)
    (out / 'graph-layout.json').write_text(json.dumps({'positions': positions, 'communities': com_of, 'order': order}))

t0 = time.time()
def stage(name):
    print('GRAPHIFY_STAGE %s %.1f' % (name, time.time() - t0), flush=True)

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

detection = detect(src)
stage('detect')
code_files = []
for f in detection.get('files', {}).get('code', []):
    p = Path(f)
    code_files.extend(collect_files(p) if p.is_dir() else [p])

if code_files:
    extracted = extract(code_files)
else:
    extracted = {'nodes': [], 'edges': [], 'input_tokens': 0, 'output_tokens': 0}
stage('extract')
if not extracted.get('nodes'):
    print('ERROR: no nodes extracted (empty or unsupported corpus)', file=sys.stderr)
    raise SystemExit(1)

G = build_from_json(extracted)
stage('build')
communities = cluster(G)
stage('cluster')
cohesion = score_all(G, communities)
stage('score')
tokens = {'input': extracted.get('input_tokens', 0), 'output': extracted.get('output_tokens', 0)}
labels = {cid: 'Community %s' % cid for cid in communities}
gods = god_nodes(G)
stage('gods')
surprises = surprising_connections(G, communities)
stage('surprises')
questions = suggest_questions(G, communities, labels)
stage('questions')
betweenness = 'exact' if G.number_of_nodes() < BOUNDED_BC_MIN_NODES else 'approx-k%d-seed42' % BOUNDED_BC_K
report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, str(src), suggested_questions=questions)
(out / 'GRAPH_REPORT.md').write_text(report)
stage('report')
to_json(G, communities, str(out / 'graph.json'))
stage('json')
has_html = False
layout = 'graphify'
if G.number_of_nodes() <= 5000 and not os.environ.get('GRAPHIFY_FORCE_LARGE'):
    to_html(G, communities, str(out / 'graph.html'), community_labels=labels or None)
    has_html = True
else:
    write_large_html(G, communities, out)
    has_html = True
    layout = 'grid-circles(approximate)'
stage('export')
print('GRAPHIFY_RESULT ' + json.dumps({'nodes': G.number_of_nodes(), 'edges': G.number_of_edges(), 'communities': len(communities), 'has_html': has_html, 'layout': layout, 'betweenness': betweenness}))
`

export interface GraphifyRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 可注入的假 runner(用例用);缺省实现起真子进程。`onLine` 逐行流转子进程 stdout,阶段标记靠它 live 上屏。 */
export type GraphifyRunner = (
  cmd: readonly string[],
  opts?: { env?: Record<string, string>, onLine?: (line: string) => void },
) => Promise<GraphifyRunResult>

export interface GraphifyServiceOptions {
  /** 产物根目录(~/.dsh/workbench/graphify/)。 */
  dir: string
  /** 项目 id → 本机路径。 */
  projectPaths: () => Promise<readonly { id: string, path: string }[]>
  run?: GraphifyRunner
  /**
   * vis-network 的下载地址(`endpoints.json` 的 viz_cdn_url;返回 undefined = 关)。
   * 不传 = 用内置默认(测试与最小装配)。
   */
  vizUrl?: () => string | undefined
  /**
   * uv 官方安装脚本下载地址(`endpoints.json` 的 uv_bootstrap_url;返回 undefined = 关)。
   * 不传 = 用内置默认(https://astral.sh/uv/install.sh)。
   */
  uvBootstrapUrl?: () => string | undefined
  /**
   * 下载内容的 sha256 校验值。缺省 = 钉死的 vis-network@9.1.9 实测值;
   * 用例注入自己的小体量假件(校验逻辑照跑,不随假件放松)。
   */
  vizSha256?: string
}

interface GraphifyJobRecord extends GraphifyJobView {
  projectId?: string
  logTail?: string
}

export interface GraphifyService {
  status: (projectId: string) => Promise<{ installed: boolean, generatedAt: number | null, hasHtml: boolean }>
  build: (projectId: string) => Promise<{ ok: true, jobId: string } | { ok: false, error: string }>
  install: () => Promise<{ ok: true, jobId: string } | { ok: false, error: string }>
  job: (id: string) => GraphifyJobView | undefined
  /** 该项目此刻有没有 build 在跑(/graphify/status 的 running 那一档)。 */
  running: (projectId: string) => boolean
  /** 从 `<dir>/<projectId>/` 读一份产物;项目 id 不合法、路径越界(含符号链接出界)或读不到回 undefined。 */
  read: (projectId: string, relPath: string) => Promise<{ data: Buffer, contentType: string } | undefined>
}

/** 项目 id 是产物根下的**一级目录名**:斜杠、反斜杠、空串、`.`/`..` 一律不合法。 */
function validProjectId(projectId: string): boolean {
  return projectId !== '' && projectId !== '.' && projectId !== '..'
    && !projectId.includes('/') && !projectId.includes('\\') && !projectId.includes('\0')
}

/** 错误输出只留尾部:整段 stderr 可能很长,界面上要的是最后那句人话。 */
function tail(text: string, max = 2_000): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/** 缺省 runner:uv 在 homebrew / 官方脚本两个位置,PATH 最前面补上它找得到。 */
const defaultRun: GraphifyRunner = (cmd, opts) => new Promise((resolvePromise) => {
  const [bin, ...args] = cmd
  if (bin === undefined) { resolvePromise({ code: -1, stdout: '', stderr: '空命令' }); return }
  const home = process.env.HOME ?? ''
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, args, {
      env: {
        ...process.env,
        PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
        ...(opts?.env ?? {}),
      },
    })
  }
  catch (error) {
    resolvePromise({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
    return
  }
  let stdout = ''
  let stderr = ''
  let pending = ''
  child.stdout?.on('data', (chunk: unknown) => {
    stdout += String(chunk)
    pending += String(chunk)
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) opts?.onLine?.(line)
  })
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
  const done = (result: GraphifyRunResult): void => {
    if (pending !== '') opts?.onLine?.(pending)
    resolvePromise(result)
  }
  child.on('error', (error: Error) => { done({ code: -1, stdout, stderr: `${stderr}${error.message}` }) })
  child.on('close', (code) => { done({ code: code ?? -1, stdout, stderr }) })
})

/** 按扩展名给 contentType;认不出的给 octet-stream。 */
function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'html':
    case 'htm': return 'text/html; charset=utf-8'
    case 'json': return 'application/json'
    case 'md': return 'text/markdown; charset=utf-8'
    case 'js': return 'text/javascript'
    case 'css': return 'text/css'
    default: return 'application/octet-stream'
  }
}

/** 从流水线 stdout 摘 GRAPHIFY_RESULT 那一行的 JSON;没有/坏了回 undefined。 */
function parsePipelineStats(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.split('\n').reverse().find(one => one.startsWith('GRAPHIFY_RESULT '))
  if (line === undefined) return undefined
  try { return JSON.parse(line.slice('GRAPHIFY_RESULT '.length)) as Record<string, unknown> }
  catch { return undefined }
}

/** 从流水线 stdout 摘最后一个完成阶段的名称;一行都没有回 undefined。 */
function lastStageOf(stdout: string): string | undefined {
  const stages = stdout.split('\n').filter(line => line.startsWith('GRAPHIFY_STAGE '))
  const last = stages[stages.length - 1]
  return last === undefined ? undefined : (last.split(' ')[1] ?? undefined)
}

export function createGraphifyService(options: GraphifyServiceOptions): GraphifyService {
  const run = options.run ?? defaultRun
  const jobs = new Map<string, GraphifyJobRecord>()

  function startJob(projectId: string | undefined): GraphifyJobRecord {
    const job: GraphifyJobRecord = {
      id: randomUUID(),
      status: 'running',
      startedAt: Date.now(),
      ...(projectId === undefined ? {} : { projectId }),
    }
    jobs.set(job.id, job)
    return job
  }

  function fail(job: GraphifyJobRecord, error: string, logTail?: string): void {
    job.status = 'error'
    job.finishedAt = Date.now()
    job.error = error
    if (logTail !== undefined) job.logTail = logTail
  }

  async function projectPathOf(projectId: string): Promise<{ ok: true, path: string } | { ok: false, error: string }> {
    const anchors = await options.projectPaths()
    const anchor = anchors.find(one => one.id === projectId)
    if (anchor === undefined) return { ok: false, error: '项目没有本机路径' }
    try { await stat(anchor.path) }
    catch { return { ok: false, error: '项目路径不存在' } }
    return { ok: true, path: anchor.path }
  }

  /** uv 缺席时按可配官方脚本下载到临时文件后执行;有了就返回 0 码的那次结果。 */
  async function ensureUv(job: GraphifyJobRecord): Promise<boolean> {
    const uv = await run(['uv', '--version'])
    if (uv.code === 0) return true
    if (options.uvBootstrapUrl !== undefined && options.uvBootstrapUrl() === undefined) {
      fail(job, 'uv 安装脚本下载被关掉了(endpoints.json 里 uv_bootstrap_url 是 off)')
      return false
    }
    const bootstrapUrl = options.uvBootstrapUrl?.() ?? DEFAULT_UV_BOOTSTRAP_URL
    const tmpScript = resolve(options.dir, `.uv-install-${randomUUID()}.sh`)
    await mkdir(options.dir, { recursive: true })
    try {
      const got = await run(['curl', '-fsSL', bootstrapUrl, '-o', tmpScript])
      if (got.code !== 0) {
        fail(job, '下载 uv 安装脚本失败', tail(got.stderr || got.stdout))
        return false
      }
      const executed = await run(['sh', tmpScript])
      if (executed.code !== 0) {
        fail(job, '执行 uv 安装脚本失败', tail(executed.stderr || executed.stdout))
        return false
      }
      const checked = await run(['uv', '--version'])
      if (checked.code === 0) return true
      fail(job, '安装 uv 后仍无法执行 uv --version', tail(checked.stderr || checked.stdout))
      return false
    }
    finally {
      await rm(tmpScript, { force: true }).catch(() => undefined)
    }
  }

  /** 「装上」的实质:把 graphifyy==0.1.14 那套环境在 uv 缓存里热好(第一次要下载)。 */
  async function runInstall(job: GraphifyJobRecord): Promise<void> {
    if (!await ensureUv(job)) return
    job.stage = 'warm'
    const warm = await run(['uv', 'run', '--with', GRAPHIFY_SPEC, 'python', '-c', 'import graphify'])
    if (warm.code !== 0) {
      fail(job, `装 graphify 失败(退出码 ${warm.code})`, tail(warm.stderr || warm.stdout))
      return
    }
    if (!await ensureVendor(job)) return
    job.status = 'done'
    job.finishedAt = Date.now()
  }

  /**
   * graph.html 里的 vis-network 换成本地那一份:vendor 目录没有就先下。
   * 下载走**临时文件 + 内容校验(钉死的 sha256)+ rename**(rename 同目录原子替换,
   * 旧的完整组件一直用到新文件验完);失败重试一次;两条作业并发首装共用同一次下载。
   * 不把要连外网或验不过的页面组件交出去。
   */
  /** 并发首装/首建共享同一次下载(单线程里的竞速窗用「promise 先建」封死)。 */
  let vendorPromise: Promise<boolean> | undefined
  const vizHash = options.vizSha256 ?? VIS_NETWORK_SHA256
  async function downloadVendor(): Promise<boolean> {
    const dir = resolve(options.dir, 'vendor')
    const target = resolve(dir, 'vis-network.min.js')
    if (await exists(target)) return true
    const url = options.vizUrl?.() ?? VIZ_CDN_URL
    await mkdir(dir, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tmp = resolve(dir, `.vis-network-${randomUUID()}.tmp`)
      const got = await run(['curl', '-fsSL', url, '-o', tmp])
      if (got.code === 0) {
        try {
          const sha = createHash('sha256').update(await readFile(tmp)).digest('hex')
          if (sha === vizHash) {
            // 临时文件校验过才 rename 覆盖:rename 是原子的,旧的完整组件一直用到最后一刻。
            await rename(tmp, target)
            return true
          }
        }
        catch { /* 读坏了照样走重试 */ }
      }
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    return false
  }

  async function ensureVendor(job: GraphifyJobRecord): Promise<boolean> {
    if (options.vizUrl !== undefined && options.vizUrl() === undefined) {
      fail(job, '图谱页的绘图组件下载被关掉了(endpoints.json 里 viz_cdn_url 是 off)')
      return false
    }
    job.stage = 'vendor'
    vendorPromise ??= downloadVendor()
    const ok = await vendorPromise.finally(() => { vendorPromise = undefined })
    if (!ok) fail(job, '装图谱页面的可视组件(vis-network)失败(下载或校验不过)')
    return ok
  }

  async function runBuild(job: GraphifyJobRecord, projectPath: string): Promise<void> {
    const staging = resolve(options.dir, `.staging-${job.id}`)
    const scriptPath = resolve(options.dir, `.pipeline-${job.id}.py`)
    const dest = resolve(options.dir, job.projectId as string)
    const backup = resolve(options.dir, `.prev-${job.id}`)
    try {
      await mkdir(options.dir, { recursive: true })
      if (!await ensureVendor(job)) return
      await writeFile(scriptPath, PIPELINE_PY, 'utf8')
      const result = await run(['uv', 'run', '--with', GRAPHIFY_SPEC, 'python', scriptPath, projectPath, staging], {
        onLine: (line) => {
          // 阶段标记 live 进作业视图:界面的「正在生成…」说得出此刻卡在哪一段。
          if (line.startsWith('GRAPHIFY_STAGE ')) {
            const stage = line.split(' ')[1]
            if (stage !== undefined) job.stage = stage
          }
        },
      })
      if (result.code !== 0) {
        const last = lastStageOf(result.stdout)
        if (last !== undefined) job.stage = last
        fail(job, `生成图谱失败(退出码 ${result.code})`, tail(result.stderr || result.stdout))
        return
      }
      // 校验:graph.json 真的在、能解析 —— 没过之前不动旧产物。
      let parsed: { nodes?: unknown } | undefined
      try {
        parsed = JSON.parse(await readFile(resolve(staging, 'graph.json'), 'utf8')) as { nodes?: unknown }
      }
      catch { /* 落到下面的「产物不齐」 */ }
      if (parsed === undefined) {
        fail(job, 'graphify 没有产出能读的 graph.json', tail(result.stderr || result.stdout))
        return
      }
      const stats = parsePipelineStats(result.stdout) ?? { nodes: 0, edges: 0, communities: 0, has_html: await exists(resolve(staging, 'graph.html')) }
      const hasHtml = stats.has_html === true
      // graph.html 要用的 vis-network 一律给本地那份:graphify 自带页是 unpkg 外链(改写),
      // 我们的大图模板本来就是相对引用(直接拷)。本地组件缺了就别让页面出去连外网。
      if (hasHtml && await exists(resolve(staging, 'graph.html'))) {
        const html = await readFile(resolve(staging, 'graph.html'), 'utf8')
        if (html.includes(VIZ_UPSTREAM_URL) || html.includes(VIZ_CDN_URL)) {
          const rewritten = html.split(VIZ_UPSTREAM_URL).join('vis-network.min.js').split(VIZ_CDN_URL).join('vis-network.min.js')
          await writeFile(resolve(staging, 'graph.html'), rewritten, 'utf8')
        }
        if (!await exists(resolve(staging, 'vis-network.min.js'))) {
          await cp(resolve(options.dir, 'vendor', 'vis-network.min.js'), resolve(staging, 'vis-network.min.js'))
        }
      }
      await writeFile(resolve(staging, 'meta.json'), JSON.stringify({
        generatedAt: Date.now(),
        projectId: job.projectId,
        projectPath,
        ...(typeof stats.nodes === 'number' ? { nodes: stats.nodes } : {}),
        ...(typeof stats.edges === 'number' ? { edges: stats.edges } : {}),
        ...(typeof stats.communities === 'number' ? { communities: stats.communities } : {}),
        hasHtml,
        ...(typeof stats.layout === 'string' ? { layout: stats.layout } : {}),
        ...(typeof stats.betweenness === 'string' ? { betweenness: stats.betweenness } : {}),
      }))
      // 可回滚替换:旧目录先挪去 .prev-,暂存挪正,成了才删旧的;挪正失败把旧的挪回来。
      let hadOld = false
      try { await stat(dest); hadOld = true }
      catch { /* 第一次生成,没有旧的 */ }
      if (hadOld) await rename(dest, backup)
      try {
        await rename(staging, dest)
      }
      catch (error) {
        if (hadOld) await rename(backup, dest).catch(() => undefined)
        fail(job, error instanceof Error ? error.message : String(error))
        return
      }
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      job.status = 'done'
      job.finishedAt = Date.now()
    }
    finally {
      await rm(scriptPath, { force: true }).catch(() => undefined)
      // 失败路径下暂存还留着(成功路径已被挪正,这里 rm 的是不存在的名字)。
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true }
    catch { return false }
  }

  return {
    async status(projectId) {
      let generatedAt: number | null = null
      if (validProjectId(projectId)) {
        try {
          const meta = JSON.parse(await readFile(resolve(options.dir, projectId, 'meta.json'), 'utf8')) as { generatedAt?: unknown }
          generatedAt = typeof meta.generatedAt === 'number' ? meta.generatedAt : null
        }
        catch { /* meta.json 缺席或写坏了就当「还没生成过」 */ }
      }
      // hasHtml 以磁盘为准(不猜):上一次真出了 graph.html 才有可嵌的页面。
      const hasHtml = validProjectId(projectId) && await exists(resolve(options.dir, projectId, 'graph.html'))
      // installed = uv 在,且 graphifyy 那套环境在 uv 缓存里热好了(--offline 探针:热了秒回,没热立刻失败)。
      const uv = await run(['uv', '--version'])
      if (uv.code !== 0) return { installed: false, generatedAt, hasHtml }
      const probe = await run(['uv', 'run', '--offline', '--with', GRAPHIFY_SPEC, 'python', '-c', 'import graphify'])
      return { installed: probe.code === 0, generatedAt, hasHtml }
    },

    async build(projectId) {
      if (!validProjectId(projectId)) return { ok: false, error: '项目 id 不合法' }
      const located = await projectPathOf(projectId)
      if (!located.ok) return located
      // 同项目在跑 → 把那条作业再给他,不起第二条(两个重建键一起按也只跑一份)。
      for (const job of jobs.values()) {
        if (job.projectId === projectId && job.status === 'running') return { ok: true, jobId: job.id }
      }
      // jobId 在长任务办完之前就返回:活儿丢去后台,前端拿 jobId 轮询。
      const job = startJob(projectId)
      void runBuild(job, located.path).catch((error: unknown) => {
        fail(job, error instanceof Error ? error.message : String(error))
      })
      return { ok: true, jobId: job.id }
    },

    async install() {
      const job = startJob(undefined)
      void runInstall(job).catch((error: unknown) => {
        fail(job, error instanceof Error ? error.message : String(error))
      })
      return { ok: true, jobId: job.id }
    },

    job(id) {
      const found = jobs.get(id)
      if (found === undefined) return undefined
      const view: GraphifyJobView = {
        id: found.id,
        status: found.status,
        startedAt: found.startedAt,
        ...(found.finishedAt === undefined ? {} : { finishedAt: found.finishedAt }),
        ...(found.error === undefined ? {} : { error: found.error }),
        ...(found.stage === undefined ? {} : { stage: found.stage }),
      }
      return view
    },

    running(projectId) {
      for (const job of jobs.values()) {
        if (job.projectId === projectId && job.status === 'running') return true
      }
      return false
    },

    async read(projectId, relPath) {
      if (!validProjectId(projectId)) return undefined
      let decoded: string
      try { decoded = decodeURIComponent(relPath) }
      catch { return undefined }
      if (decoded === '' || decoded.includes('\\') || decoded.startsWith('/')) return undefined
      if (decoded.split('/').some(segment => segment === '..')) return undefined
      // realpath 三道:产物根解析一回,项目目录解析一回(它自己是个指到根外的 symlink 也挡),
      // 目标再解析一回 —— 任何一环翻出产物根都 undefined(2026-10-23 第三轮验收:哨兵实证)。
      const baseReal = await realpath(options.dir).catch(() => resolve(options.dir))
      const rootReal = await realpath(resolve(options.dir, projectId)).catch(() => undefined)
      if (rootReal === undefined) return undefined
      if (relative(baseReal, rootReal).startsWith('..') || isAbsolute(relative(baseReal, rootReal))) return undefined
      const target = resolve(rootReal, decoded)
      if (relative(rootReal, target).startsWith('..') || isAbsolute(relative(rootReal, target))) return undefined
      const targetReal = await realpath(target).catch(() => undefined)
      if (targetReal === undefined) return undefined
      if (relative(baseReal, targetReal).startsWith('..') || isAbsolute(relative(baseReal, targetReal))) return undefined
      let data: Buffer
      try { data = await readFile(targetReal) }
      catch { return undefined }
      return { data, contentType: contentTypeOf(targetReal) }
    },
  }
}
