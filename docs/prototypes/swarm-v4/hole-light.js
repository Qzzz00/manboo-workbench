// One cached, continuous light field for all enclosed holes of the current
// glyph. No extra GL context, no per-frame flood fill or particle-sized sprites.
class IconHoleLight {
  /** @param {SolidHoles} holes */
  constructor(holes) {
    this.holes=holes;this.width=holes.width*3;this.height=holes.height*3;
    this.data=new Uint8ClampedArray(this.width*this.height*4);this.samples=[];
    this.canvas=null;this.image=null;this.lastKey='';
    const at=(x,y,id)=>x<0||y<0||x>=holes.width||y>=holes.height||holes.labels[y*holes.width+x]!==id?0:holes.depth[y*holes.width+x];
    for(let y=0;y<this.height;y++)for(let x=0;x<this.width;x++){
      const cell=Math.floor(y/3)*holes.width+Math.floor(x/3),id=holes.labels[cell];if(!id)continue;
      const gx=(x+.5)/3-.5,gy=(y+.5)/3-.5,ix=Math.floor(gx),iy=Math.floor(gy),u=gx-ix,v=gy-iy;
      const d=(at(ix,iy,id)*(1-u)+at(ix+1,iy,id)*u)*(1-v)+(at(ix,iy+1,id)*(1-u)+at(ix+1,iy+1,id)*u)*v;
      const edge=Math.min(1,d*holes.regions[id-1].maxDepth/Math.min(holes.spanX/holes.width,holes.spanY/holes.height)*1.6);
      this.samples.push({k:(y*this.width+x)*4,density:(.16+2.9*d**.65)*edge,
        a:Math.sin(gx*.23+gy*.17+id*1.7),b:Math.cos(gx*.16-gy*.25+id*.8)});
    }
  }
  pixels(time,rgb,brightness) {
    const a=Math.cos(time*.73),b=Math.sin(time*.61);
    for(const sample of this.samples){
      const k=sample.k,flow=.84+.10*sample.a*a+.06*sample.b*b;
      this.data[k]=rgb[0];this.data[k+1]=rgb[1];this.data[k+2]=rgb[2];
      this.data[k+3]=Math.round(255*(1-Math.exp(-Math.max(0,brightness)*sample.density*flow)));
    }
    return this.data;
  }
  texture(time,rgb,brightness) {
    if(!this.canvas){
      this.canvas=document.createElement('canvas');this.canvas.width=this.width;this.canvas.height=this.height;
      this.image=this.canvas.getContext('2d').createImageData(this.width,this.height);
    }
    const key=`${time}/${rgb}/${brightness}`;
    if(key!==this.lastKey){this.image.data.set(this.pixels(time,rgb,brightness));this.canvas.getContext('2d').putImageData(this.image,0,0);this.lastKey=key;}
    return this.canvas;
  }
  draw(ctx,time,rgb,brightness,pose,depth,R,W,H,alpha,theme) {
    const texture=this.texture(time,rgb,brightness),h=this.holes,mesh=4,points=[];
    for(let y=0;y<=mesh;y++)for(let x=0;x<=mesh;x++){
      const px=x/mesh,py=y/mesh;
      points.push(projectHolePoint((px-.5)*h.spanX,(py-.5)*h.spanY,.055*(pose.matrix?1:depth),pose,R,W,H));
    }
    ctx.save();ctx.globalAlpha=alpha;ctx.globalCompositeOperation=theme==='dark'?'screen':'source-over';
    for(let y=0;y<mesh;y++)for(let x=0;x<mesh;x++){
      const i=y*(mesh+1)+x,sx=x*this.width/mesh,sy=y*this.height/mesh,dx=this.width/mesh,dy=this.height/mesh;
      // Two affine triangles per small tile approximate the perspective plane.
      this.triangle(ctx,texture,[sx,sy,sx+dx,sy,sx,sy+dy],[points[i],points[i+1],points[i+mesh+1]]);
      this.triangle(ctx,texture,[sx+dx,sy,sx+dx,sy+dy,sx,sy+dy],[points[i+1],points[i+mesh+2],points[i+mesh+1]]);
    }
    ctx.restore();
  }
  triangle(ctx,texture,uv,p) {
    const [x0,y0,x1,y1,x2,y2]=uv,den=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);
    const a=((p[1][0]-p[0][0])*(y2-y0)-(p[2][0]-p[0][0])*(y1-y0))/den;
    const b=((p[1][1]-p[0][1])*(y2-y0)-(p[2][1]-p[0][1])*(y1-y0))/den;
    const c=((p[2][0]-p[0][0])*(x1-x0)-(p[1][0]-p[0][0])*(x2-x0))/den;
    const d=((p[2][1]-p[0][1])*(x1-x0)-(p[1][1]-p[0][1])*(x2-x0))/den;
    ctx.save();ctx.beginPath();ctx.moveTo(...p[0]);ctx.lineTo(...p[1]);ctx.lineTo(...p[2]);ctx.closePath();ctx.clip();
    ctx.transform(a,b,c,d,p[0][0]-a*x0-c*y0,p[0][1]-b*x0-d*y0);ctx.drawImage(texture,0,0);ctx.restore();
  }
}

// Same transform order and perspective as the solid particles.
function projectHolePoint(x,y,z,pose,R,W,H) {
  if(pose.matrix){
    const m=pose.matrix,xx=m[0]*x+m[3]*y+m[6]*z,yy=m[1]*x+m[4]*y+m[7]*z,zz=m[2]*x+m[5]*y+m[8]*z;
    const perspective=4.2/(4.2-zz);return [W/2+xx*R*perspective,H/2+yy*R*perspective];
  }
  const cy=Math.cos(pose.yaw),sy=Math.sin(pose.yaw),cp=Math.cos(pose.pitch),sp=Math.sin(pose.pitch),cr=Math.cos(pose.roll),sr=Math.sin(pose.roll);
  const xx=x*cy+z*sy,zz=z*cy-x*sy,yy=y*cp-zz*sp;
  z=(y*sp+zz*cp)*pose.scale;x=(xx*cr-yy*sr)*pose.scale;y=(xx*sr+yy*cr)*pose.scale;
  const perspective=4.2/(4.2-z);return [W/2+x*R*perspective,H/2+y*R*perspective];
}
