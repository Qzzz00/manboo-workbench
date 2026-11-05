// A continuous emissive volume, sharing the outer flock's simulation clock.
// Optical density controls integration; emitted radiance controls the image.
class LightCloud {
  constructor() {
    this.size=160;
    this.canvas=document.createElement('canvas');this.canvas.width=160;this.canvas.height=160;
    this.kind='canvas';this.gl=null;this.program=null;this.uniforms={};this.tint='';
    try {
      const gl=this.canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
      if(gl)this.initVolume(gl);
    } catch (_) {this.gl=null;}
    if(!this.gl)this.initFallback();
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.gl=null;this.initFallback();});
  }
  initVolume(gl) {
    const vertex='attribute vec2 position; varying vec2 uv; void main(){uv=position;gl_Position=vec4(position,0.,1.);}';
    const fragment=`precision mediump float;
      varying vec2 uv; uniform float time; uniform float work; uniform vec3 tint;
      uniform float emission; uniform float focus; uniform float halo;
      float field(vec3 p) {
        vec3 q=p*(.68+focus*.5);
        q+=.10*vec3(sin(p.y*2.8+time*.47)+cos(p.z*3.1-time*.32),sin(p.z*2.5+time*.36),cos(p.x*2.7-time*.4));
        float body=1.-smoothstep(.28,.9,length(q));
        float folds=sin(q.x*5.1+sin(q.z*3.8+time*.6)+time*.35)*cos(q.y*4.3-time*.4);
        float density=.38+.62*pow(.5+.5*folds,2.);
        return body*body*density;
      }
      void main(){
        vec2 xy=uv*1.35;xy.y=-xy.y;
        xy/=vec2(1.+work*.28,1.-work*.28);
        float opacity=0.;float light=0.;
        for(int i=0;i<24;i++){
          float z=1.15-float(i)*.1;
          vec3 p=vec3(xy,z);
          float d=field(p);
          float a=1.-exp(-d*.10);
          float core=exp(-dot(p,p)*(3.+focus*2.4));
          float fold=.5+.5*sin(p.x*4.6+p.z*3.7+sin(p.y*3.-time*.4)+time*.53);
          light+=(1.-opacity)*d*(.55+core*2.4+fold*1.2)*.20;
          opacity+=(1.-opacity)*a;
        }
        float fringe=exp(-dot(xy,xy)*5.5)*(1.-smoothstep(.65,1.05,length(xy)))*halo*.16;
        float energy=1.-exp(-emission*(light+fringe));
        // Circular transparent gutter prevents work stretching from clipping a
        // volume against the square texture; RGB/alpha stay truly premultiplied.
        energy*=1.-smoothstep(.86,.96,length(uv));
        gl_FragColor=vec4(tint*energy,energy);
      }`;
    const compile=(type,src)=>{const shader=gl.createShader(type);gl.shaderSource(shader,src);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);throw new Error('Volume shader unavailable');}return shader;};
    const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment),program=gl.createProgram();
    gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);throw new Error('Volume program unavailable');}
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    this.uniforms={time:gl.getUniformLocation(program,'time'),work:gl.getUniformLocation(program,'work'),tint:gl.getUniformLocation(program,'tint'),emission:gl.getUniformLocation(program,'emission'),focus:gl.getUniformLocation(program,'focus'),halo:gl.getUniformLocation(program,'halo')};
    this.gl=gl;this.program=program;this.kind='webgl';
  }
  initFallback() {
    // A canvas cannot switch from an acquired WebGL context to 2D.
    this.canvas=document.createElement('canvas');this.canvas.width=this.size;this.canvas.height=this.size;
    this.ctx=this.canvas.getContext('2d');this.fieldCanvas=document.createElement('canvas');this.fieldCanvas.width=this.size;this.fieldCanvas.height=this.size;
    this.fieldCtx=this.fieldCanvas.getContext('2d');
    this.kind='canvas';this.tint='';
  }
  /** Texture edge in device pixels; resizing resets the drawing buffer, so only apply real changes. */
  setResolution(size) {
    const next=Math.max(16,Math.round(size));if(next===this.size)return;
    this.size=next;this.canvas.width=next;this.canvas.height=next;
    if(this.fieldCanvas){this.fieldCanvas.width=next;this.fieldCanvas.height=next;}
  }
  /** @param {Record<string,number>} settings */
  paint(time,work,rgb,settings={},activity=0) {
    const brightness=Math.max(0,Math.min(3,Number.isFinite(settings.cloudBrightness)?settings.cloudBrightness:1));
    const focus=Math.max(.5,Math.min(2,Number.isFinite(settings.cloudFocus)?settings.cloudFocus:1));
    const halo=Math.max(0,Math.min(1,Number.isFinite(settings.cloudHalo)?settings.cloudHalo:.35));
    const emission=brightness*(1+Math.max(0,Math.min(1,Number.isFinite(activity)?activity:0))*.12);
    if(this.gl) {
      const gl=this.gl,size=this.size;gl.viewport(0,0,size,size);gl.useProgram(this.program);
      gl.uniform1f(this.uniforms.time,time);gl.uniform1f(this.uniforms.work,work);gl.uniform3f(this.uniforms.tint,rgb[0]/255,rgb[1]/255,rgb[2]/255);
      gl.uniform1f(this.uniforms.emission,emission);gl.uniform1f(this.uniforms.focus,focus);gl.uniform1f(this.uniforms.halo,halo);
      gl.drawArrays(gl.TRIANGLES,0,6);return this.canvas;
    }
    const color=rgb.join(','),ctx=this.ctx,brush=this.fieldCtx,r=43/(.7+focus*.45),size=this.size,unit=size/160;
    const x=Math.sin(time*.33)*r*.075,y=Math.cos(time*.29)*r*.06;
    // The fallback field is authored in 160 px units and scaled to the current texture size.
    brush.clearRect(0,0,size,size);brush.save();brush.translate(size/2,size/2);brush.scale(unit*(1+work*.28),unit*(1-work*.28));
    // Four overlapping continuous gradients form one connected field. Tone map
    // radiance inside the field, including black contrast on the light theme.
    const gradient=(cx,cy,radius,levels)=>{
      const fill=brush.createRadialGradient(cx,cy,0,cx,cy,radius);
      for(const [at,light] of levels)fill.addColorStop(at,`rgba(${color},${1-Math.exp(-emission*light)})`);
      brush.fillStyle=fill;brush.fillRect(cx-radius,cy-radius,radius*2,radius*2);
    };
    if(halo>0)gradient(0,0,56,[[0,halo*.065],[.35,halo*.045],[.75,halo*.012],[1,0]]);
    gradient(x,y,r,[[0,1.05],[.25,.8],[.55,.34],[.83,.055],[1,0]]);
    gradient(x+Math.cos(time*.47)*r*.18,y+Math.sin(time*.36)*r*.13,r*.66,[[0,.24],[.4,.14],[.78,.025],[1,0]]);
    gradient(x-Math.sin(time*.38)*r*.2,y-Math.cos(time*.42)*r*.17,r*.58,[[0,.18],[.4,.09],[.8,.015],[1,0]]);
    brush.restore();ctx.clearRect(0,0,size,size);ctx.drawImage(this.fieldCanvas,0,0,size,size);return this.canvas;
  }
}
