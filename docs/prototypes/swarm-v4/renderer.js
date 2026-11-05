// Device-pixel alignment: integer edge length (never below one device pixel) with edges on the
// device grid, so a square is a crisp block instead of a blurred, half-covered smear. `coverage`
// keeps the light budget of a particle that was smaller than the pixel it now fills.
function alignSquare(px,py,size,dpr) {
  const device=Math.max(1,Math.round(size*dpr)),x=Math.round(px*dpr-device/2),y=Math.round(py*dpr-device/2);
  return {x:x/dpr,y:y/dpr,size:device/dpr,coverage:Math.min(1,(size*dpr)*(size*dpr)/(device*device))};
}
// Offscreen light texture sized to the sphere's real device pixels (16 px steps, 64–320), so a
// 280 px sphere at DPR 2 is no longer a 160 px texture stretched over 560 device pixels.
function cloudResolutionFor(deviceDiameter,scale=1) {
  const wanted=(Number.isFinite(deviceDiameter)?deviceDiameter:0)*Math.max(.25,Math.min(1,scale));
  return Math.max(64,Math.min(320,Math.round(wanted/16)*16));
}
class SwarmRenderer {
  constructor(canvas,swarm) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.swarm=swarm;this.width=400;this.height=400;this.dpr=1;this.cloudScale=1;
    this.rgb=[255,255,255];this.from=[255,255,255];this.target=[255,255,255];this.colorAge=1;this.theme='dark';
    this.cloud=new LightCloud();this.glow=null;this.glowTint='';this.holeLayers={face:null,icon:null};
    this.items=Array.from({length:swarm.count+1},(_,i)=>({i,z:0}));this.resize();
  }
  setColor(theme,notice) {
    this.theme=theme;
    const palette=theme==='light'?{neutral:[0,0,0],completed:[39,102,193],confirmation:[155,106,16],failed:[180,51,51]}:{neutral:[255,255,255],completed:[109,175,255],confirmation:[243,197,99],failed:[243,130,130]};
    this.from=this.rgb.slice();this.target=palette[notice]||palette.neutral;this.colorAge=0;
  }
  resize() {
    const r=this.canvas.getBoundingClientRect();this.width=r.width||400;this.height=r.height||400;
    const dpr=Math.min(devicePixelRatio||1,2);this.dpr=dpr;this.canvas.width=Math.round(this.width*dpr);this.canvas.height=Math.round(this.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  paint(dt=0,snap=false) {
    const s=this.swarm,settings=s.settings,ctx=this.ctx,W=this.width,H=this.height,R=Math.min(W,H)*.32*settings.bodySize;
    if(this.items.length!==s.count+1)this.items=Array.from({length:s.count+1},(_,i)=>({i,z:0}));
    this.colorAge=snap?1:Math.min(1,this.colorAge+dt/.75);const u=this.colorAge*this.colorAge*(3-2*this.colorAge);
    this.rgb=this.from.map((v,i)=>Math.round(v+(this.target[i]-v)*u));const color=`rgb(${this.rgb.join(',')})`;
    ctx.clearRect(0,0,W,H);ctx.fillStyle=color;
    const f=Math.max(0,Math.min(1,s.face.value)),c=Math.max(0,Math.min(1,s.call.value)),w=Math.max(0,Math.min(1,s.work.value));
    const solid=Math.max(0,Math.min(1,s.solidMix||0)),core=(1-f)*(1-c);
    for(const kind of ['face','icon']){
      const glyph=kind==='face'?s.glyphs?.[s.expression]:s.activeIcon,holes=glyph?.solid?.holes,weight=kind==='face'?f:c;
      if(!holes||weight<.001){this.holeLayers[kind]=null;continue;}
      let layer=this.holeLayers[kind];
      if(layer?.holes!==holes)layer=this.holeLayers[kind]={holes,light:new IconHoleLight(holes),age:0};
      layer.age=snap?1:Math.min(1,layer.age+dt/.38);
    }
    const dpr=this.dpr,cloudRadius=R*1.3*settings.cloudSize;
    if(core>.005&&settings.cloudSize>0&&settings.cloudBrightness>0)this.cloud.setResolution?.(cloudResolutionFor(cloudRadius*2*dpr,this.cloudScale));
    const cloudImage=core>.005&&settings.cloudSize>0&&settings.cloudBrightness>0?this.cloud.paint(s.cloudTime,w,this.rgb,settings,s.dialogue?.level||0):null;
    const glowKey=`${color}@${dpr}`;
    if(settings.particleGlow>0&&this.glowTint!==glowKey){
      // The soft sprite is baked at device resolution: 48 CSS px × DPR, so it is not upsampled on Retina.
      const side=Math.round(48*dpr),half=side/2;
      if(!this.glow)this.glow=document.createElement('canvas');
      this.glow.width=this.glow.height=side;
      const brush=this.glow.getContext('2d'),gradient=brush.createRadialGradient(half,half,0,half,half,half),rgb=this.rgb.join(',');
      gradient.addColorStop(0,`rgba(${rgb},.55)`);gradient.addColorStop(.3,`rgba(${rgb},.16)`);gradient.addColorStop(1,`rgba(${rgb},0)`);
      brush.clearRect(0,0,side,side);brush.fillStyle=gradient;brush.fillRect(0,0,side,side);this.glowTint=glowKey;
    }
    if(this.canvas.dataset)this.canvas.dataset.cloudRenderer=this.cloud.kind;
    for(const item of this.items)item.z=item.i<s.count?s.positions[item.i*3+2]:0;
    this.items.sort((a,b)=>a.z-b.z);
    for(const item of this.items) {
      const i=item.i;
      if(i>=s.count) {
        const cr=cloudRadius;
        if(cloudImage){
          // Emitted light cannot cover rear particles with grey. The light
          // theme uses black source-over contrast; particle blending stays normal.
          ctx.globalCompositeOperation=this.theme==='dark'?'screen':'source-over';
          ctx.globalAlpha=core*.92;ctx.drawImage(cloudImage,W/2-cr,H/2-cr,cr*2,cr*2);
          ctx.globalCompositeOperation='source-over';
        }
        for(const kind of ['face','icon']){
          const layer=this.holeLayers[kind],weight=kind==='face'?f:c;
          if(!layer||settings.cloudBrightness<=0)continue;
          const u=Math.max(0,Math.min(1,(weight-.65)/.33)),v=layer.age;
          const alpha=u*u*(3-2*u)*v*v*(3-2*v);
          if(alpha>0)layer.light.draw(ctx,s.cloudTime,this.rgb,settings.cloudBrightness,s.getRenderedSolidPose(kind),settings.iconDepth,R,W,H,alpha,this.theme);
        }
        continue;
      }
      const k=i*3,x=s.positions[k],y=s.positions[k+1],z=s.positions[k+2],seed=s.seeds[i];
      const p=4.2/(4.2-z),depth=Math.max(0,Math.min(1,(z+1)/2)),px=W/2+x*R*p,py=H/2+y*R*p;
      let size=s.sizes[i]*(.34+depth*.94)*p,alpha=(.075+depth**2.1*.84)*(.88+.12*Math.sin(s.time*.8+seed*60));
      if(f>.001&&solid<.001) {if(s.feature[i]){alpha+=(1-alpha)*f;}else {
        const soft=1-Math.min(1,((x+.06)/.6)**2+((y-.08)/.56)**2);
        alpha*=1-f*.12*soft*soft*(3-2*soft);
      }}
      if(c>.001){alpha=Math.min(1,alpha+c*.28);}
      if(solid>.001){
        const light=s.surfaceLight[i],material=(.15+light*.78)*(.66+.34*depth);
        alpha=alpha*(1-solid)+material*solid;
      }
      // Morph positions and surface lighting, not the user's particle material.
      // Keep each particle's original size distribution throughout icon transitions.
      size*=settings.particleSize;alpha=Math.min(1,alpha*settings.particleBrightness);
      if(this.glow&&settings.particleGlow>0&&depth>.42&&i%2===0){const r=size*(5+settings.particleGlow*5);ctx.globalAlpha=alpha*settings.particleGlow*.8*(1-solid*.65);ctx.drawImage(this.glow,px-r/2,py-r/2,r,r);}
      if(w>.01&&i%5===0) {
        const old=4.2/(4.2-s.previous[k+2]),ox=W/2+s.previous[k]*R*old,oy=H/2+s.previous[k+1]*R*old;
        ctx.globalAlpha=alpha*w*.25;ctx.strokeStyle=color;ctx.lineWidth=Math.max(.45,size*.45);ctx.beginPath();ctx.moveTo(px+(ox-px)*5,py+(oy-py)*5);ctx.lineTo(px,py);ctx.stroke();
      }
      const square=alignSquare(px,py,size,dpr);
      ctx.globalAlpha=Math.min(1,alpha*square.coverage);ctx.fillRect(square.x,square.y,square.size,square.size);
    }
    ctx.globalAlpha=1;
  }
}
