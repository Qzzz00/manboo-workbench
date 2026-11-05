// Local-only SVG import. Only a newly rebuilt geometry tree ever enters the DOM.
// No imported scripts, URLs, images, stylesheets, Blob URLs, or network requests.
const particleSVGNS = 'http://www.w3.org/2000/svg';
const particleSVGShapes = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon']);
const particleSVGNumbers = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** @param {string} value @param {string} label */
function particleSVGNumberList(value, label) {
  const tokens = value.match(particleSVGNumbers) || [];
  if (!tokens.length || value.replace(particleSVGNumbers, '').replace(/[\s,]/g, '') || tokens.some(token => !Number.isFinite(+token) || Math.abs(+token) > 1e7)) {
    throw new Error(`SVG ${label} 含无效或非有限数字。`);
  }
  return tokens.map(Number);
}

/** @param {string} value */
function particleSVGTransform(value) {
  const expressions = [...value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)];
  if (!expressions.length || value.replace(/(matrix|translate|scale|rotate|skewX|skewY)\s*\([^)]*\)/g, '').trim()) throw new Error('SVG transform 参数格式不支持。');
  for (const expression of expressions) {
    const count = particleSVGNumberList(expression[2], 'transform').length;
    const valid = expression[1] === 'matrix' ? count === 6 : expression[1] === 'rotate' ? count === 1 || count === 3 : expression[1].startsWith('skew') ? count === 1 : count === 1 || count === 2;
    if (!valid) throw new Error('SVG transform 参数数量无效。');
  }
  return value;
}

/** SVG exporters commonly include an external DOCTYPE. Strip a standalone
 * prolog declaration BEFORE DOMParser sees it; never load its external DTD.
 * Internal subsets/entities stay unsupported, rather than expanding them.
 * @param {string} text @returns {string}
 */
function stripParticleSVGDoctype(text) {
  text=text.replace(/^\uFEFF/,'');
  if (/<!\s*ENTITY\b/i.test(text)) throw new Error('SVG 含自定义实体，暂不支持；请导出为不依赖实体的普通 SVG。');
  if (/<\?(?!xml\s)/i.test(text)) throw new Error('SVG 不支持样式表等处理指令，请导出为普通 SVG。');
  const prolog=text.match(/^\s*(?:(?:<\?xml\s[\s\S]*?\?>|<!--[\s\S]*?-->)\s*)*/i)[0];
  const rest=text.slice(prolog.length);
  if (/^<!DOCTYPE\b/i.test(rest)) {
    // Only `svg`, optionally with quoted PUBLIC/SYSTEM identifiers, is allowed.
    // Quotes cannot hide subset brackets or extra markup inside the declaration.
    const declaration=rest.match(/^<!DOCTYPE\s+svg(?:\s+(?:SYSTEM\s+(?:"[^"<>\[\]]*"|'[^'<>\[\]]*')|PUBLIC\s+(?:"[^"<>\[\]]*"|'[^'<>\[\]]*')\s+(?:"[^"<>\[\]]*"|'[^'<>\[\]]*')))?\s*>/i);
    if (!declaration) throw new Error('SVG 的 DOCTYPE 含内部子集或声明格式不支持，请导出为普通 SVG。');
    const afterDeclaration=rest.slice(declaration[0].length);
    if (/<\?xml\s/i.test(afterDeclaration)) throw new Error('SVG 的 XML 声明必须位于 DOCTYPE 之前。');
    text=prolog+afterDeclaration;
  }
  if (/<!\s*DOCTYPE\b/i.test(text)) throw new Error('SVG 的 DOCTYPE 重复、位置或声明格式不正确。');
  return text;
}

/** Rebuild a safe SVG using a strict geometry/presentation allowlist.
 * @param {string} text @returns {string}
 */
function sanitizeParticleSVG(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请选择包含几何图形的 SVG 文件。');
  if (text.length > 256 * 1024 || new Blob([text]).size > 256 * 1024) throw new Error('SVG 文件不能超过 256KB。');
  text=stripParticleSVGDoctype(text);
  const input = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = input.documentElement;
  if (input.querySelector('parsererror') || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== particleSVGNS)) throw new Error('SVG XML 解析失败或根元素格式不正确。');
  const forbidden = new Set(['script', 'foreignobject', 'image', 'use', 'style', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'iframe', 'object', 'embed', 'audio', 'video']);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (forbidden.has(element.localName.toLowerCase())) throw new Error(`SVG 安全限制：不支持 ${element.localName} 元素。`);
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.localName) || /^(?:href|src)$/i.test(attr.localName) || /url\s*\(|javascript\s*:|@import/i.test(attr.value)) throw new Error('SVG 含事件、外链或危险内容，已拒绝导入。');
    }
  }
  const output = document.implementation.createDocument(particleSVGNS, 'svg', null);
  let geometryCount = 0;
  const numeric = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'stroke-width', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity']);
  const presentations = new Set(['fill', 'stroke', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity']);
  /** @param {Element} target @param {string} name @param {string} value */
  const copyAttribute = (target, name, value) => {
    value = value.trim();
    if (name === 'transform') target.setAttribute(name, particleSVGTransform(value));
    else if (name === 'd') {
      if (!/^[\sMmZzLlHhVvCcSsQqTtAa0-9eE+.,-]+$/.test(value) || !/^[Mm]/.test(value)) throw new Error('SVG path 几何格式无效。');
      const numbers = value.match(particleSVGNumbers) || [];
      if (numbers.some(token => !Number.isFinite(+token) || Math.abs(+token) > 1e7)) throw new Error('SVG path 含非有限数字。');
      target.setAttribute(name, value);
    } else if (name === 'viewBox' || name === 'points') {
      const values = particleSVGNumberList(value, name);
      if ((name === 'viewBox' && (values.length !== 4 || values[2] <= 0 || values[3] <= 0)) || (name === 'points' && (values.length < 4 || values.length % 2))) throw new Error(`SVG ${name} 几何格式无效。`);
      target.setAttribute(name, value);
    } else if (numeric.has(name)) {
      const values = particleSVGNumberList(value.replace(/px$/, ''), name);
      if (values.length !== 1 || (['r', 'rx', 'ry', 'width', 'height', 'stroke-width'].includes(name) && values[0] < 0)) throw new Error(`SVG ${name} 数字格式无效。`);
      target.setAttribute(name, String(values[0]));
    } else if (presentations.has(name)) {
      if (!/^[a-zA-Z0-9#().,%\s+-]+$/.test(value)) throw new Error(`SVG ${name} 样式格式不支持。`);
      if (name === 'fill-rule' && !['nonzero', 'evenodd'].includes(value)) throw new Error('SVG fill-rule 参数不支持。');
      target.setAttribute(name, value);
    }
  };
  /** @param {Element} from @param {Element} to @param {number} depth */
  const rebuild = (from, to, depth) => {
    if (depth > 32) throw new Error('SVG 分组层级过深，请简化几何。');
    for (const attr of [...from.attributes]) {
      if (attr.name === 'style') {
        for (const part of attr.value.split(';')) {
          const colon = part.indexOf(':');
          if (colon < 0) continue;
          const name = part.slice(0, colon).trim();
          if (presentations.has(name)) copyAttribute(to, name, part.slice(colon + 1));
        }
      } else if (!attr.namespaceURI) copyAttribute(to, attr.name, attr.value);
    }
    for (const child of [...from.children]) {
      if (child.namespaceURI && child.namespaceURI !== particleSVGNS) continue;
      if (child.localName !== 'g' && !particleSVGShapes.has(child.localName)) continue;
      if (particleSVGShapes.has(child.localName) && ++geometryCount > 128) throw new Error('SVG 几何不能超过 128 个。');
      const clean = output.createElementNS(particleSVGNS, child.localName);
      to.appendChild(clean);
      rebuild(child, clean, depth + 1);
    }
  };
  rebuild(root, output.documentElement, 0);
  if (!geometryCount) throw new Error('SVG 没有可导入的几何图形；请将文字或引用转换为路径。');
  return new XMLSerializer().serializeToString(output.documentElement);
}

/** @typedef {{start:number,count:number,closed:boolean}} ParticleSVGRange */
/** @typedef {{width:number,height:number,spanX:number,spanY:number,labels:Uint16Array,depth:Float32Array,regions:{size:number,maxDepth:number}[]}} SolidHoles */
/** @typedef {{depth:Float32Array,radius:Float32Array,nx:Float32Array,ny:Float32Array,nz:Float32Array,holes?:SolidHoles}} SolidParticleField */
/** @typedef {Float32Array & {ranges?:ParticleSVGRange[],scatter?:boolean,solid?:SolidParticleField}} ImportedParticleGlyph */

// Background connected to ANY border (including diagonals) is exterior. Work
// from SVG occupancy, never particle gaps; retain no field for open-only icons.
/** @returns {SolidHoles|null} */
function findSolidHoles(mask,width,height,spanX,spanY) {
  const labels=new Uint16Array(mask.length),queue=new Uint16Array(mask.length),outside=65535;
  const flood=(start,label)=>{
    let head=0,tail=1;queue[0]=start;labels[start]=label;
    while(head<tail){
      const k=queue[head++],x=k%width,y=Math.floor(k/width);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,yy=y+dy;if(xx<0||xx>=width||yy<0||yy>=height)continue;
        const next=yy*width+xx;if(mask[next]||labels[next])continue;
        labels[next]=label;queue[tail++]=next;
      }
    }
    return tail;
  };
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const k=y*width+x;if((x===0||y===0||x===width-1||y===height-1)&&!mask[k]&&!labels[k])flood(k,outside);
  }
  const regions=[];
  for(let k=0;k<mask.length;k++)if(!mask[k]&&!labels[k])regions.push({size:flood(k,regions.length+1),maxDepth:0});
  if(!regions.length)return null;
  const depth=new Float32Array(mask.length),dx=spanX/width,dy=spanY/height,diag=Math.hypot(dx,dy);
  for(let k=0;k<labels.length;k++){if(labels[k]===outside)labels[k]=0;else if(labels[k])depth[k]=100;}
  // All hole cells are interior to the grid: no out-of-bounds neighbours.
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const k=y*width+x;if(labels[k])depth[k]=Math.min(depth[k],depth[k-1]+dx,depth[k-width]+dy,depth[k-width-1]+diag,depth[k-width+1]+diag);
  }
  for(let y=height-2;y>0;y--)for(let x=width-2;x>0;x--){
    const k=y*width+x;if(labels[k]){
      depth[k]=Math.min(depth[k],depth[k+1]+dx,depth[k+width]+dy,depth[k+width+1]+diag,depth[k+width-1]+diag);
      const region=regions[labels[k]-1];region.maxDepth=Math.max(region.maxDepth,depth[k]);
    }
  }
  for(let k=0;k<labels.length;k++)if(labels[k])depth[k]/=regions[labels[k]-1].maxDepth;
  return {width,height,spanX,spanY,labels,depth,regions};
}

// A padded chamfer distance field keeps holes/components intact. Constructed
// once per imported icon, never in the animation loop. Units are model-space.
function buildSolidGlyph(mask,width,height,spanX=1.7,spanY=1.7) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>80||height>80||mask.length!==width*height||![spanX,spanY].every(v=>Number.isFinite(v)&&v>0))throw new Error('实心网格尺寸无效。');
  const stride=width+2,dx=spanX/width,dy=spanY/height,diagonal=Math.hypot(dx,dy);
  const distance=new Float32Array(stride*(height+2)),heightMap=new Float32Array(distance.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(mask[y*width+x])distance[(y+1)*stride+x+1]=100;
  for(let y=1;y<=height;y++)for(let x=1;x<=width;x++){
    const k=y*stride+x;if(!distance[k])continue;
    distance[k]=Math.min(distance[k],distance[k-1]+dx,distance[k-stride]+dy,distance[k-stride-1]+diagonal,distance[k-stride+1]+diagonal);
  }
  for(let y=height;y>=1;y--)for(let x=width;x>=1;x--){
    const k=y*stride+x;if(!distance[k])continue;
    distance[k]=Math.min(distance[k],distance[k+1]+dx,distance[k+stride]+dy,distance[k+stride+1]+diagonal,distance[k+stride-1]+diagonal);
  }
  let count=0;
  for(let y=1;y<=height;y++)for(let x=1;x<=width;x++){
    const k=y*stride+x;if(!distance[k])continue;count++;
    const d=Math.max(0,distance[k]-Math.min(dx,dy)*.5),u=Math.min(1,d/.3);
    heightMap[k]=.02+.4*Math.sqrt(u*(2-u));
  }
  const glyph=/** @type {ImportedParticleGlyph} */(new Float32Array(count*2));
  const field={depth:new Float32Array(count),radius:new Float32Array(count),nx:new Float32Array(count),ny:new Float32Array(count),nz:new Float32Array(count)};
  let i=0;
  for(let y=1;y<=height;y++)for(let x=1;x<=width;x++){
    const k=y*stride+x;if(!distance[k])continue;
    glyph[i*2]=((x-.5)/width-.5)*spanX;glyph[i*2+1]=((y-.5)/height-.5)*spanY;
    field.depth[i]=heightMap[k];field.radius[i]=Math.min(.038,Math.max(0,distance[k]-Math.min(dx,dy)*.5)*.38);
    const nx=-(heightMap[k+1]-heightMap[k-1])/(2*dx),ny=-(heightMap[k+stride]-heightMap[k-stride])/(2*dy),length=Math.hypot(nx,ny,1);
    field.nx[i]=nx/length;field.ny[i]=ny/length;field.nz[i]=1/length;i++;
  }
  glyph.scatter=true;glyph.solid=field;field.holes=findSolidHoles(mask,width,height,spanX,spanY);return glyph;
}

/** Sample native SVG geometry in a temporary offscreen viewport.
 * Outline coordinates retain independent shape ranges; compound paths use a
 * scatter field to avoid interpolation across disconnected native subpaths.
 * Fill uses native winding rules (including holes), also with local motion.
 * @param {string} text
 * @param {{fill?:boolean}} [options]
 * @returns {Promise<{glyph:ImportedParticleGlyph,svg:string,warnings:string[]}>}
 */
async function sampleImportedSVG(text, { fill = false } = {}) {
  const svg = sanitizeParticleSVG(text);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:-20000px;width:1024px;height:1024px;opacity:0;pointer-events:none;contain:strict;';
  host.setAttribute('aria-hidden', 'true');
  const root = /** @type {SVGSVGElement} */(/** @type {unknown} */(document.importNode(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, true)));
  root.setAttribute('width', '1024');
  root.setAttribute('height', '1024');
  host.appendChild(root);
  const warnings = [];
  if (/<(?:[\w-]+:)?(?:text|defs|title|desc|metadata|clipPath|mask)\b/i.test(text)) warnings.push('已忽略文字、定义、裁剪和元数据，仅导入基础几何。');
  try {
    document.body.appendChild(host);
    const elements = /** @type {SVGGeometryElement[]} */([...root.querySelectorAll('path,circle,rect,ellipse,line,polyline,polygon')]);
    /** @param {Element} element */
    const hasFill=element=>{
      let fillValue=null,fillOpacity=null,opacity=1;
      for(let node=element;node;node=node.parentElement){
        if(fillValue===null&&node.hasAttribute('fill'))fillValue=node.getAttribute('fill');
        if(fillOpacity===null&&node.hasAttribute('fill-opacity'))fillOpacity=Number(node.getAttribute('fill-opacity'));
        if(node.hasAttribute('opacity'))opacity*=Number(node.getAttribute('opacity'));
        if(node===root)break;
      }
      // Native isPointInFill tests geometry, not paint alpha. Exporter spacer
      // rectangles may use transparent RGBA/hex instead of fill="none".
      const paint=(fillValue||'').trim().toLowerCase();
      const channels=paint.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/)?.[1].split(',');
      const alpha=channels?.length===4?channels[3].trim():null;
      const zeroAlpha=alpha!==null&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/.test(alpha)&&parseFloat(alpha)<=0;
      const transparent=paint==='none'||paint==='transparent'||/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(paint)||zeroAlpha;
      return !transparent&&opacity>0&&fillOpacity!==0;
    };
    const painted=fill?elements.filter(hasFill):elements;
    const shapes = (painted.length?painted:elements).map(element => {
      if (typeof element.getTotalLength !== 'function' || typeof element.getPointAtLength !== 'function' || typeof element.getCTM !== 'function') throw new Error('当前浏览器不支持原生 SVG 几何采样，请使用现代浏览器。');
      const length = element.getTotalLength(), matrix = element.getCTM();
      if (!matrix || !Number.isFinite(length)) throw new Error('SVG 几何采样失败。');
      const scale = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
      return { element, length, matrix, weight: length * scale, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    }).filter(shape => shape.length > 0 && shape.weight > 0);
    if (!shapes.length) throw new Error('SVG 几何尺寸为零，没有可采样轮廓。');
    // M/m cannot occur in SVG numeric tokens. Detect multiple native subpaths
    // without interpreting relative coordinates, curves, arcs or closing rules.
    const compoundPath = shapes.some(shape => shape.element.localName === 'path' && ((shape.element.getAttribute('d') || '').match(/[Mm]/g) || []).length > 1);
    const totalWeight = shapes.reduce((sum, shape) => sum + shape.weight, 0);
    if (!Number.isFinite(totalWeight)) throw new Error('SVG 变换后的几何超出可采样范围。');
    const points = [], ranges = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const shape of shapes) {
      // A filled shape needs bounds, not 8000 traced edge points. Native SVG
      // bounds include curve extrema; transform its corners into root space.
      const box=fill&&typeof shape.element.getBBox==='function'?shape.element.getBBox():null;
      const corners=box?[[box.x,box.y],[box.x+box.width,box.y],[box.x+box.width,box.y+box.height],[box.x,box.y+box.height]]:null;
      const count = corners?4:8 + Math.floor((8000 - shapes.length * 8) * shape.weight / totalWeight);
      const start = points.length / 2;
      for (let i = 0; i < count; i++) {
        const p = corners?{x:corners[i][0],y:corners[i][1]}:shape.element.getPointAtLength(shape.length * i / (count - 1)), m = shape.matrix;
        const x = m.a * p.x + m.c * p.y + m.e, y = m.b * p.x + m.d * p.y + m.f;
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.max(Math.abs(x), Math.abs(y)) > 1e12) throw new Error('SVG 几何采样出现无效坐标。');
        points.push(x, y);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        shape.minX = Math.min(shape.minX, x); shape.maxX = Math.max(shape.maxX, x); shape.minY = Math.min(shape.minY, y); shape.maxY = Math.max(shape.maxY, y);
      }
      const end = points.length - 2;
      ranges.push({ start, count, closed: Math.hypot(points[start * 2] - points[end], points[start * 2 + 1] - points[end + 1]) <= Math.max(1e-5, shape.weight * 1e-5) });
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (!(span > 1e-9)) throw new Error('SVG 几何尺寸过小，无法采样。');
    let sampled = points;
    if (fill) {
      if (shapes.some(shape => typeof shape.element.isPointInFill !== 'function')) throw new Error('当前浏览器不支持 SVG 实心采样。');
      sampled = [];
      // Respect inherited paint: e.g. Tabler's invisible full-viewBox path
      // must not turn a smile's negative space into a solid rectangle.
      const filledShapes=shapes.filter(shape=>hasFill(shape.element));
      const mask=new Uint8Array(80*80);let left=80,top=80,right=-1,bottom=-1;
      // Bounded 80×80 grid: at most 6400 returned fill points. Reject points by
      // per-shape bounds before asking native geometry; no canvas/image decode.
      for (let row = 0; row < 80; row++) for (let col = 0; col < 80; col++) {
        const x = minX + (col + .5) / 80 * (maxX - minX), y = minY + (row + .5) / 80 * (maxY - minY);
        const inside = filledShapes.some(shape => {
          if (x < shape.minX || x > shape.maxX || y < shape.minY || y > shape.maxY) return false;
          const m = shape.matrix, det = m.a * m.d - m.b * m.c;
          if (Math.abs(det) < 1e-12) return false;
          const dx = x - m.e, dy = y - m.f;
          return shape.element.isPointInFill({ x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det });
        });
        if (inside) {sampled.push(x, y);mask[row*80+col]=1;left=Math.min(left,col);right=Math.max(right,col);top=Math.min(top,row);bottom=Math.max(bottom,row);}
      }
      if(sampled.length){
        // Transformed local boxes are conservative for rotated curves. Tighten
        // to occupied cells so a rotated circle cannot become a smaller icon.
        const width=right-left+1,height=bottom-top+1,cropped=new Uint8Array(width*height);
        for(let row=0;row<height;row++)cropped.set(mask.subarray((top+row)*80+left,(top+row)*80+right+1),row*width);
        const sx=(maxX-minX)*width/80,sy=(maxY-minY)*height/80,filledSpan=Math.max(sx,sy);
        return {glyph:buildSolidGlyph(cropped,width,height,sx/filledSpan*1.7,sy/filledSpan*1.7),svg,warnings};
      }
      if (!sampled.length) {
        const outline=await sampleImportedSVG(svg);
        return {...outline,warnings:[...new Set([...warnings,...outline.warnings,'没有可填充的区域，已使用轮廓采样。'])]};
      }
    }
    const glyph = /** @type {ImportedParticleGlyph} */(new Float32Array(sampled.length));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let i = 0; i < sampled.length; i += 2) {
      glyph[i] = (sampled[i] - cx) / span * 1.7;
      glyph[i + 1] = (sampled[i + 1] - cy) / span * 1.7;
    }
    if (fill) glyph.scatter = true;
    else {
      glyph.ranges = ranges;
      if (compoundPath) {
        glyph.scatter = true;
        warnings.push('检测到复合路径，已改为整图局部活动，避免粒子跨越断开的子路径。');
      }
    }
    return { glyph, svg, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new Error(/[\u3400-\u9fff]/.test(message) ? message : 'SVG 几何采样失败，请检查路径和尺寸。');
  } finally {
    host.remove();
  }
}
