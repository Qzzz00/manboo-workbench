// Tabler Icons v3.46.0, MIT, Copyright (c) 2020-2026 Paweł Kuna.
// Original SVGs retained in assets/. Facial outer circles intentionally omitted:
// the flock's volume supplies the head, not a rigid icon outline.
function sampleGlyphs() {
  const atlas={};
  for(const svg of document.querySelectorAll('svg[data-glyph]')) {
    const points=[],ranges=[];
    for(const element of svg.querySelectorAll('path[data-feature]')) {
      const path=/** @type {SVGPathElement} */(element);
      if(typeof path.getTotalLength!=='function')continue;
      const length=path.getTotalLength(),count=Math.max(20,Math.ceil(length*35));
      const first=path.getPointAtLength(0),last=path.getPointAtLength(length);
      ranges.push({start:points.length/2,count,closed:length>1&&Math.hypot(first.x-last.x,first.y-last.y)<.05});
      for(let i=0;i<count;i++) {
        const p=path.getPointAtLength(length*i/Math.max(1,count-1));
        // Area sampling around each SVG stroke, including round endpoints.
        const a=i*2.39996,r=Math.sqrt((i*.618034)%1)*.40;
        points.push((p.x+Math.cos(a)*r-12)/10,(p.y+Math.sin(a)*r-12)/10);
      }
    }
    atlas[svg.getAttribute('data-glyph')]=Object.assign(new Float32Array(points),{ranges});
  }
  return atlas;
}
