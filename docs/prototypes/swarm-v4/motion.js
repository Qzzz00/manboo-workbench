// Original local dynamics. Semi-implicit damped springs retain velocity on interruption.
class Spring {
  constructor(value = 0, stiffness = 92, damping = 15) { this.value=value; this.velocity=0; this.stiffness=stiffness; this.damping=damping; }
  step(target, elapsed) {
    const dt=Math.max(0,Math.min(.05,Number.isFinite(elapsed)?elapsed:0));
    const steps=Math.max(1,Math.ceil(dt*120)), h=dt/steps;
    for(let i=0;i<steps;i++) {this.velocity+=((target-this.value)*this.stiffness-this.velocity*this.damping)*h;this.value+=this.velocity*h;}
    return this.value;
  }
  snap(value) {this.value=value;this.velocity=0;}
}

// A local demo score, not microphone/TTS analysis. Phrases have unequal lengths
// and silences; the same clock drives inward listening and outward speech.
function dialogueScore(time) {
  const t=time%24.8,phrases=[[.35,2.65],[3.65,5.25],[6.5,9.65],[10.95,12.4],[13.5,16.15],[18.05,21.1]];
  let level=0;
  for(let i=0;i<phrases.length;i++){
    const [start,end]=phrases[i];if(t<start||t>end)continue;
    const u=t-start,smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x)};
    const gate=smooth(u/.17)*smooth((end-t)/.24);
    const syllable=Math.max(0,Math.sin(u*(17.3+i*.63)+i*.9));
    const stress=.65+.35*Math.sin(u*3.1+i*1.7)**2;
    level=gate*(.12+.88*syllable**1.5)*stress;
  }
  let nod=0;
  for(const start of [2.93,9.99,16.55]){const u=(t-start)/.72;if(u>0&&u<1)nod=Math.sin(Math.PI*u)**2;}
  return {level,nod};
}

class SwarmV4 {
  constructor(count=3600, glyphs={}) {
    this.count=count;this.glyphs=glyphs;this.activeIcon=null;this.settings=/** @type {Record<string,number>} */({...TUNING_DEFAULTS,count});
    this.positions=new Float32Array(count*3);this.previous=new Float32Array(count*3);this.velocity=new Float32Array(count*3);
    this.base=new Float32Array(count*3);this.seeds=new Float32Array(count);this.sizes=new Float32Array(count);
    this.angles=new Float32Array(count);this.feature=new Uint8Array(count);this.surfaceLight=new Float32Array(count).fill(1);this.solidMix=0;
    this.mode='idle';this.expression='smile';this.time=0;this.age=0;this.phase=0;this.workTime=0;this.cloudTime=0;this.iconTime=0;this.ringTime=0;
    this.face=new Spring();this.work=new Spring();this.listen=new Spring();this.call=new Spring();
    this.speech=new Spring();this.attentionPitch=new Spring(0,150,23);
    this.dialogueTime=0;this.dialogue={level:0,nod:0,active:false,kind:'none'};
    this.spin=new Spring(.30,55,15);this.nod=new Spring(0,110,17);this.phoneRock=new Spring(0,170,17);
    this.solidTransforms={face:null,icon:null};
    const golden=Math.PI*(3-Math.sqrt(5));
    for(let i=0;i<count;i++) {
      const seed=this.random(i+11),y=1-2*(i+.5)/count,lat=Math.sqrt(1-y*y),a=i*golden;
      const r=i%5<2 ? .25+Math.cbrt(seed)*.66 : .88+seed*.12;
      this.base.set([Math.cos(a)*lat*r,y*r,Math.sin(a)*lat*r],i*3);
      this.seeds[i]=seed;this.sizes[i]=.70+Math.pow(this.random(i+93),2)*2.25;
      this.feature[i]=i%8===0?1:0;
    }
    this.positions.set(this.base);this.previous.set(this.base);
  }
  random(i) {const n=Math.sin(i*127.1+311.7)*43758.5453;return n-Math.floor(n);}
  configure(input) {
    const next=normalizeTuning(input,this.settings);
    if(next.count!==this.count){
      const fresh=new SwarmV4(next.count,this.glyphs),keep=Math.min(this.count,next.count);
      for(const name of ['positions','previous','velocity'])fresh[name].set(this[name].subarray(0,keep*3));
      fresh.angles.set(this.angles.subarray(0,keep));
      for(const name of ['positions','previous','velocity','base','seeds','sizes','angles','feature','surfaceLight'])this[name]=fresh[name];
      this.count=next.count;
    }
    this.settings=next;
    for(const spring of [this.face,this.work,this.listen,this.call,this.speech]){spring.stiffness=92*next.morphSpeed**2;spring.damping=(19-4*next.bounce)*next.morphSpeed;}
  }
  setMode(mode) {
    if(!['idle','listening','acknowledging','working','speaking','expressing','calling','custom','builtin'].includes(mode))return;
    // Keep the outgoing contour while its blend weight decays to the sphere.
    if(['calling','custom','builtin'].includes(mode))this.activeIcon=this.glyphs[mode==='calling'?'phone':mode];
    this.mode=mode;this.age=0;this.ringTime=0;this.dialogueTime=0;
    if(mode==='acknowledging')this.expression='smile';
  }
  setExpression(name) {if(['smile','wink','happy'].includes(name))this.expression=name;}
  getSolidPose(kind) {
    if(kind==='face')return {scale:this.settings.iconSize,yaw:-.15+Math.sin(this.iconTime*.48)*.12,pitch:this.nod.value,roll:0};
    if(kind==='icon')return {scale:this.settings.iconSize*1.12,yaw:.24+Math.sin(this.iconTime*.48)*.24,pitch:0,roll:this.phoneRock.value};
  }
  getRenderedSolidPose(kind) {
    const transform=this.solidTransforms[kind];
    return transform?{matrix:transform.map(s=>s.value)}:this.getSolidPose(kind);
  }
  stepSolidTransform(kind,pose,dt,snap) {
    // Filter transformed basis vectors, not Euler angles: this is the same
    // linear position spring as a fixed material anchor in the particle body.
    const cy=Math.cos(pose.yaw),sy=Math.sin(pose.yaw),cp=Math.cos(pose.pitch),sp=Math.sin(pose.pitch),cr=Math.cos(pose.roll),sr=Math.sin(pose.roll);
    const target=[];
    for(let axis=0;axis<3;axis++){
      const x=axis===0?1:0,y=axis===1?1:0,z=axis===2?this.settings.iconDepth:0;
      const xx=x*cy+z*sy,zz=z*cy-x*sy,yy=y*cp-zz*sp;
      target.push((xx*cr-yy*sr)*pose.scale,(xx*sr+yy*cr)*pose.scale,(y*sp+zz*cp)*pose.scale);
    }
    if(!this.solidTransforms[kind])this.solidTransforms[kind]=target.map(value=>new Spring(value));
    this.solidTransforms[kind].forEach((spring,i)=>{
      spring.stiffness=115*this.settings.morphSpeed**2;
      spring.damping=(24-5*this.settings.bounce)*this.settings.morphSpeed;
      if(snap)spring.snap(target[i]);else spring.step(target[i],dt);
    });
  }
  // Stay inside one SVG component: eyes never migrate into the mouth.
  sampleGlyph(glyph,anchor,time,speed,out) {
    const total=glyph.length/2,index=Math.floor(anchor)%total;
    if(glyph.scatter){out[0]=glyph[index*2];out[1]=glyph[index*2+1];return out;}
    const range=glyph.ranges?.find(r=>index>=r.start&&index<r.start+r.count)||{start:0,count:total,closed:true};
    const phase=(index-range.start)/Math.max(1,range.count);
    const cycle=phase+time*speed;
    const u=range.closed?cycle-Math.floor(cycle):.5-.5*Math.cos(cycle*Math.PI*2);
    const position=u*(range.closed?range.count:range.count-1),a=Math.floor(position),mix=position-a;
    const j=(range.start+a)*2,k=(range.start+(a+1)%range.count)*2;
    out[0]=glyph[j]+(glyph[k]-glyph[j])*mix;out[1]=glyph[j+1]+(glyph[k+1]-glyph[j+1])*mix;
    return out;
  }
  // Low-discrepancy area anchors, plus a bounded local orbit. Both faces are
  // populated; unlike uniform extrusion, thickness tapers at every boundary.
  sampleSolid(glyph,index,time,out) {
    const j=Math.floor(((index*.61803398875)%1)*(glyph.length/2)),field=glyph.solid;
    const seed=this.seeds[index%this.count],phase=time*.86+seed*31,r=field.radius[j];
    out[0]=glyph[j*2]+Math.cos(phase)*r;out[1]=glyph[j*2+1]+Math.sin(phase)*r;
    const side=index%7<2?-1:1,layer=index%7===2?.28:1;
    out[2]=side*field.depth[j]*layer*(1+.045*Math.sin(time*1.1+seed*13))*this.settings.iconDepth;
    out[3]=field.nx[j];out[4]=field.ny[j];out[5]=field.nz[j]*side;
    return out;
  }
  // Closed currents guide the working flock; the inner light is a density volume.
  current(u,lane,out) {
    const t=this.workTime, a=u+lane*.61;
    const r=.40+(lane%4)*.105;
    const yaw=lane*.77+t*.13;
    const sx=Math.cos(a)*r, sy=Math.sin(a)*r*.74, sz=Math.sin(a*2+lane)*.22;
    const x=sx*Math.cos(yaw)+sz*Math.sin(yaw), z=-sx*Math.sin(yaw)+sz*Math.cos(yaw);
    const w=Math.max(0,Math.min(1,this.work.value));
    const wx=Math.sin(u+lane*.39+t*.56)*1.12;
    const wy=Math.sin(u*2+lane*2.094+t*.38)*.28;
    const wz=Math.cos(u+lane*2.094+t*.34)*.61;
    out[0]=x+(wx-x)*w;out[1]=sy+(wy-sy)*w;out[2]=z+(wz-z)*w;
    return out;
  }
  step(elapsed, snap=false) {
    const dt=Math.max(0,Math.min(.05,Number.isFinite(elapsed)?elapsed:0));
    const settings=this.settings;
    if(!snap){this.time+=dt;this.age+=dt;this.workTime+=dt*settings.workSpeed;this.cloudTime+=dt*settings.cloudSpeed;this.iconTime+=dt*settings.iconFlow;this.ringTime+=dt*settings.swaySpeed;}
    const inFace=this.mode==='acknowledging'||this.mode==='expressing';
    const isIcon=this.mode==='calling'||this.mode==='custom'||this.mode==='builtin';
    const goals=[inFace?1:0,this.mode==='working'?1:0,this.mode==='listening'?1:0,isIcon?1:0,this.mode==='idle'?settings.spinSpeed:0];
    [this.face,this.work,this.listen,this.call,this.spin].forEach((s,i)=>snap?s.snap(goals[i]):s.step(goals[i],dt));
    if(snap)this.speech.snap(this.mode==='speaking'?1:0);else this.speech.step(this.mode==='speaking'?1:0,dt);
    const communicating=this.mode==='listening'||this.mode==='speaking';
    if(!snap&&communicating)this.dialogueTime+=dt*(this.mode==='speaking'?settings.speechSpeed:1);
    const score=dialogueScore(this.dialogueTime),targetLevel=communicating?score.level:0;
    if(!snap)this.dialogue.level+=(targetLevel-this.dialogue.level)*(1-Math.exp(-dt*18));
    this.dialogue.nod=this.mode==='listening'?score.nod*settings.listenNod:0;
    this.dialogue.kind=communicating?this.mode:'none';this.dialogue.active=this.dialogue.level>.08&&communicating;
    const attention=this.mode==='listening'?-.065-.16*this.dialogue.nod:0;
    if(snap)this.attentionPitch.snap(attention);else this.attentionPitch.step(attention,dt);
    const nodTarget=this.mode==='acknowledging'&&this.age>.8&&this.age<1.15?-.22:0;
    if(snap)this.nod.snap(0);else this.nod.step(nodTarget,dt);
    const ringPhase=this.ringTime%4.6,ringU=Math.max(0,Math.min(1,(ringPhase-.3)/1.5));
    const rockTarget=isIcon?Math.sin(ringU*Math.PI)**2*Math.sin(ringU*Math.PI*4)*.19*settings.sway:0;
    if(snap)this.phoneRock.snap(0);else this.phoneRock.step(rockTarget,dt);
    const f=Math.max(0,Math.min(1.04,this.face.value)),w=Math.max(0,Math.min(1.04,this.work.value));
    const l=Math.max(0,Math.min(1,this.listen.value)),c=Math.max(0,Math.min(1.04,this.call.value));
    const speaking=Math.max(0,Math.min(1,this.speech.value)),energy=this.dialogue.level;
    const t=this.time,pitch=this.nod.value,cp=Math.cos(pitch),sp=Math.sin(pitch);
    const glyph=this.glyphs[this.expression],phone=this.activeIcon,it=this.iconTime;
    const solidFace=!!glyph?.solid,solidIcon=!!phone?.solid;
    this.solidMix=Math.max(0,Math.min(1,(solidFace?f:0)+(solidIcon?c:0)));
    this.previous.set(this.positions);
    const flow=[0,0,0],sample=[0,0],surface=[0,0,0,0,0,1];
    const facePose=this.getSolidPose('face'),iconPose=this.getSolidPose('icon');
    this.stepSolidTransform('face',facePose,dt,snap);this.stepSolidTransform('icon',iconPose,dt,snap);
    const cr=Math.cos(iconPose.roll),sr=Math.sin(iconPose.roll);
    for(let i=0;i<this.count;i++) {
      const k=i*3,s=this.seeds[i],bx=this.base[k],by=this.base[k+1],bz=this.base[k+2];
      if(!snap)this.angles[i]+=this.spin.value*dt*(.66+s*.66+Math.sin(t*.6+s*30)*.1);
      const a=this.angles[i],ca=Math.cos(a),sa=Math.sin(a);
      const drift=s*71;
      let illumination=1;
      let x=bx*ca+bz*sa,y=by,z=-bx*sa+bz*ca;
      x+=Math.sin(t*.54+drift)*(.025+.012*l)*settings.drift;y+=Math.sin(t*.43+drift*1.3)*.027*settings.drift;z+=Math.cos(t*.48+drift)*.025*settings.drift;
      if(l>.001&&s>.78) {const edge=Math.max(0,Math.hypot(x,y)-.64);const spread=edge*l*(.33+.24*Math.sin(t*.48+drift));x*=1+spread;y*=1+spread;}
      if(l>.001){
        const front=Math.max(0,Math.min(1,(bz+.25)/1.25)),radius=Math.hypot(bx,by),local=Math.exp(-radius*radius*2.3)*front;
        const receive=l*settings.listenResponse;
        const ripple=Math.sin(radius*10+this.dialogueTime*5.8);
        const travel=-energy*receive*.065*local;
        x*=1+travel;y*=1+travel;
        z+=local*(receive*.055-energy*receive*.04)+receive*.016*energy*ripple*front;
        // Underlying current remains alive during pauses, directed inward.
        x-=receive*.018*front*Math.sin(this.dialogueTime*.7+radius*3)*bx;
        const pitch=this.attentionPitch.value,cos=Math.cos(pitch),sin=Math.sin(pitch),oldY=y;
        y=oldY*cos-z*sin;z=oldY*sin+z*cos;
      }
      if(speaking>.001&&settings.speechResponse>0){
        const emit=speaking*settings.speechResponse,radius=Math.hypot(bx,by);
        const syllable=emit*energy,radial=syllable*(.11+.055*Math.sin(drift+t*1.7));
        const current=emit*.018*Math.sin(this.dialogueTime*.82+drift);
        x+=x*radial+current*(.45+.3*Math.abs(by));
        y+=y*radial*(.72+.18*Math.sin(drift*1.3))+current*.62*Math.cos(drift*.71);
        z+=z*radial*(.88+.15*Math.sin(radius*11-this.dialogueTime*5.8))+current*.78*Math.sin(drift*.53);
      }
      if(f>.001&&solidFace){
        this.sampleSolid(glyph,i,it,surface);
        const {yaw,scale}=facePose,cy=Math.cos(yaw),sy=Math.sin(yaw);
        const rx=surface[0]*cy+surface[2]*sy,rz=-surface[0]*sy+surface[2]*cy;
        x+=(rx*scale-x)*f;y+=((surface[1]*cp-rz*sp)*scale-y)*f;z+=((surface[1]*sp+rz*cp)*scale-z)*f;
        const nx=surface[3]*cy+surface[5]*sy,nz=-surface[3]*sy+surface[5]*cy,ny=surface[4]*cp-nz*sp;
        illumination=.22+.78*Math.max(0,-nx*.38-ny*.46+(surface[4]*sp+nz*cp)*.80);
      }else if(f>.001) {
        const breath=1+Math.sin(t*.85)*.016;
        let fx=bx*breath+Math.sin(t*.58+drift)*.022,fy=by*breath+Math.cos(t*.47+drift)*.023,fz=bz*breath+Math.sin(t*.52+drift)*.026;
        if(this.feature[i]&&glyph?.length) {
          this.sampleGlyph(glyph,Math.floor(i/8)/Math.ceil(this.count/8)*(glyph.length/2),it,.045+s*.022,sample);
          fx=sample[0]*.98+Math.sin(t*1.1+drift)*.006;fy=sample[1]*.98+Math.cos(t*.9+drift)*.007;
          fz=Math.sqrt(Math.max(.04,.92-fx*fx-fy*fy))+.035+(s-.5)*.035+Math.sin(t*.8+drift)*.016;
        }
        const yaw=-.14,rx=fx*Math.cos(yaw)+fz*Math.sin(yaw),rz=-fx*Math.sin(yaw)+fz*Math.cos(yaw);
        x+=(rx-x)*f;y+=(fy*cp-rz*sp-y)*f;z+=(fy*sp+rz*cp-z)*f;
      }
      if(w>.001) {
        this.current(i/this.count*Math.PI*2+s*.04,i%9,flow);
        x+=(flow[0]+Math.sin(drift)*.038-x)*w;y+=(flow[1]+Math.cos(drift)*.037-y)*w;z+=(flow[2]+Math.sin(drift*2)*.046-z)*w;
      }
      if(c>.001&&solidIcon){
        this.sampleSolid(phone,i,it,surface);
        const {yaw,scale}=iconPose,cy=Math.cos(yaw),sy=Math.sin(yaw);
        const rx=surface[0]*cy+surface[2]*sy,rz=-surface[0]*sy+surface[2]*cy;
        x+=((rx*cr-surface[1]*sr)*scale-x)*c;y+=((rx*sr+surface[1]*cr)*scale-y)*c;z+=(rz*scale-z)*c;
        const nx=surface[3]*cy+surface[5]*sy,ny=surface[4],nz=-surface[3]*sy+surface[5]*cy;
        illumination=.22+.78*Math.max(0,-(nx*cr-ny*sr)*.38-(nx*sr+ny*cr)*.46+nz*.80);
      }else if(c>.001&&phone?.length) {
        this.sampleGlyph(phone,i/this.count*(phone.length/2),it,.034+s*.022,sample);
        const depth=((s-.5)*.32+Math.sin(it*1.3+drift)*.024)*settings.iconDepth;
        const ix=(sample[0]*1.25+Math.sin(it*1.2+drift)*.009)*settings.iconSize,iy=(sample[1]*1.25+Math.cos(it+drift)*.009)*settings.iconSize;
        const yaw=.24+Math.sin(it*.8)*.12,rx=ix*Math.cos(yaw)+depth*Math.sin(yaw);
        x+=(rx*cr-iy*sr-x)*c;y+=(rx*sr+iy*cr-y)*c;z+=(-ix*Math.sin(yaw)+depth*Math.cos(yaw)-z)*c;
      }
      this.surfaceLight[i]=Math.max(0,Math.min(1,illumination));
      const target=[x,y,z];
      for(let axis=0;axis<3;axis++) {
        const n=k+axis;
        if(snap){this.positions[n]=target[axis];this.velocity[n]=0;continue;}
        const steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps;
        for(let step=0;step<steps;step++) {this.velocity[n]+=((target[axis]-this.positions[n])*115*settings.morphSpeed**2-this.velocity[n]*(24-5*settings.bounce)*settings.morphSpeed)*h;this.positions[n]+=this.velocity[n]*h;}
      }
    }
  }
}
