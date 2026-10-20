// Optional worker-only WebGL2 compute. The CPU algorithms and header CRC reader
// remain the fallback/authority; no intermediate search image is displayed.
(function(root){
  'use strict';
  const vertex=`#version 300 es
    void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`;
  const common=`#version 300 es
    precision highp float;precision highp int;
    uniform sampler2D source;uniform ivec2 imageSize;
    out vec4 outputValue;
    float sampleAt(sampler2D tex,vec2 p,ivec2 size){
      if(any(lessThan(p,vec2(0.)))||any(greaterThan(p,vec2(size-1))))return 0.;
      ivec2 a=ivec2(floor(p)),b=min(a+1,size-1);vec2 f=fract(p);
      return mix(mix(texelFetch(tex,a,0).r,texelFetch(tex,ivec2(b.x,a.y),0).r,f.x),
        mix(texelFetch(tex,ivec2(a.x,b.y),0).r,texelFetch(tex,b,0).r,f.x),f.y);
    }
  `;
  class SearchGpu{
    constructor(){
      const started=performance.now();
      this.stats={backend:'CPU',gpuFfts:0,gpuPilots:0,gpuMilliseconds:0,gpuReadbackMilliseconds:0,gpuSkippedPilots:0};this.textures=[];this.programs=[];
      try{
        if(typeof OffscreenCanvas!=='function')throw Error('OffscreenCanvas is unavailable in this browser worker');
        const canvas=new OffscreenCanvas(1,1),gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false});
        this.gl=gl;
        if(!gl)throw Error('WebGL2 is unavailable in this browser worker');
        if(!gl.getExtension('EXT_color_buffer_float'))throw Error('WebGL2 float render targets (EXT_color_buffer_float) are unavailable');
        this.framebuffer=gl.createFramebuffer();this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
        gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        this.init=this.program(common+`
          uniform ivec2 sampledSize;uniform ivec2 bits;uniform int stride;
          int reverseBits(int n,int count){int r=0;for(int i=0;i<16;i++){if(i>=count)break;r=(r<<1)|(n&1);n>>=1;}return r;}
          float taperAt(int p,int span){float edge=float(min(p,span-1-p)),ramp=max(1.,float(span)*.08);
            return edge>=ramp?1.:.4+.6*(1.-cos(3.141592653589793*edge/ramp))*.5;}
          void main(){ivec2 p=ivec2(gl_FragCoord.xy),q=ivec2(reverseBits(p.x,bits.x),reverseBits(p.y,bits.y));
            if(any(greaterThanEqual(q,sampledSize))){outputValue=vec4(0.);return;}
            ivec2 s=min(imageSize-1,q*stride);
            float v=4.*texelFetch(source,s,0).r-texelFetch(source,max(ivec2(0),s-ivec2(1,0)),0).r
              -texelFetch(source,min(imageSize-1,s+ivec2(1,0)),0).r-texelFetch(source,max(ivec2(0),s-ivec2(0,1)),0).r
              -texelFetch(source,min(imageSize-1,s+ivec2(0,1)),0).r;
            outputValue=vec4(v*taperAt(q.x,sampledSize.x)*taperAt(q.y,sampledSize.y),0.,0.,1.);
          }`);
        this.fft=this.program(common+`
          uniform int axis;uniform int span;
          void main(){ivec2 p=ivec2(gl_FragCoord.xy);int index=axis==0?p.x:p.y,halfSpan=span/2;
            int j=index%halfSpan,low=index/span*span+j;
            ivec2 a=axis==0?ivec2(low,p.y):ivec2(p.x,low),b=a+(axis==0?ivec2(halfSpan,0):ivec2(0,halfSpan));
            vec2 u=texelFetch(source,a,0).rg,v=texelFetch(source,b,0).rg;
            float angle=-6.283185307179586*float(j)/float(span);vec2 w=vec2(cos(angle),sin(angle));
            vec2 t=vec2(v.x*w.x-v.y*w.y,v.x*w.y+v.y*w.x);
            outputValue=vec4(index%span<halfSpan?u+t:u-t,0.,1.);
          }`);
        // Assign complete fragment outputs. The phone compiler rejects loop
        // indexing of outputValue, even when the loop has a constant bound.
        this.power=this.program(common+`
          float powerAt(ivec2 p){vec2 v=texelFetch(source,p,0).rg;return dot(v,v);}
          void main(){ivec2 p=ivec2(gl_FragCoord.xy)*ivec2(4,1);
            outputValue=vec4(powerAt(p),powerAt(p+ivec2(1,0)),powerAt(p+ivec2(2,0)),powerAt(p+ivec2(3,0)));
          }`);
        this.wavelet=this.program(common+`
          uniform vec3 taps[16];
          void main(){vec2 p=gl_FragCoord.xy-.5;float sum=0.,squares=0.,projection=0.;
            for(int i=0;i<16;i++){float v=sampleAt(source,p+taps[i].xy,imageSize);sum+=v;squares+=v*v;projection+=v*taps[i].z;}
            outputValue=vec4(projection/sqrt(400.+max(0.,squares-sum*sum/16.)),0.,0.,1.);
          }`);
        this.pilot=this.program(common+`
          uniform vec2 points[24];uniform vec4 signs[24];uniform int scanStep;
          void main(){vec2 p=vec2(ivec2(gl_FragCoord.xy)*scanStep);float energy=0.;vec4 agreement=vec4(0.);
            for(int i=0;i<24;i++){
              float v=sampleAt(source,p+points[i],imageSize);energy+=abs(v);agreement+=v*signs[i];
              if(i==11&&(energy<96.||agreement.x/energy<.45)){outputValue=vec4(0.);return;}
            }
            if(energy<192.){outputValue=vec4(0.);return;}
            vec4 quality=agreement/energy;
            outputValue=quality*min(1.,energy/288.)*step(vec4(.58),quality);
          }`);
        this.luma=this.texture(gl.R32F,gl.RED);this.complex=[this.texture(gl.RG32F,gl.RG),this.texture(gl.RG32F,gl.RG)];
        this.packed=this.texture(gl.RGBA32F,gl.RGBA);this.field=this.texture(gl.R32F,gl.RED);this.scores=this.texture(gl.RGBA32F,gl.RGBA);
        this.stats.backend='GPU FFT + pilots';
      }catch(error){this.disable(error);}
      this.pendingInitMilliseconds=performance.now()-started;
    }
    program(fragment){
      const gl=this.gl,compile=(type,source)=>{
        const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
        if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const error=Error(gl.getShaderInfoLog(s));gl.deleteShader(s);throw error;}return s;
      };
      const v=compile(gl.VERTEX_SHADER,vertex),f=compile(gl.FRAGMENT_SHADER,fragment),p=gl.createProgram();
      gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);gl.deleteShader(v);gl.deleteShader(f);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)){const error=Error(gl.getProgramInfoLog(p));gl.deleteProgram(p);throw error;}
      const result={handle:p,uniforms:new Map()};this.programs.push(p);return result;
    }
    uniform(program,name){
      if(!program.uniforms.has(name))program.uniforms.set(name,this.gl.getUniformLocation(program.handle,name));
      return program.uniforms.get(name);
    }
    texture(internal,format){
      const gl=this.gl,handle=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,handle);
      for(const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,p,gl.NEAREST);
      for(const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);
      const result={handle,internal,format,w:0,h:0};this.textures.push(handle);return result;
    }
    size(texture,w,h,data){
      const gl=this.gl;gl.bindTexture(gl.TEXTURE_2D,texture.handle);
      if(texture.w!==w||texture.h!==h){gl.texImage2D(gl.TEXTURE_2D,0,texture.internal,w,h,0,texture.format,gl.FLOAT,data||null);texture.w=w;texture.h=h;}
      else if(data)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,w,h,texture.format,gl.FLOAT,data);
    }
    upload(luma,w,h){
      if(this.lastLuma!==luma||this.luma.w!==w||this.luma.h!==h){this.size(this.luma,w,h,luma);this.lastLuma=luma;}
    }
    draw(program,input,target,w,h,configure){
      const gl=this.gl;this.size(target,w,h);gl.bindFramebuffer(gl.FRAMEBUFFER,this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target.handle,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Float framebuffer unavailable');
      gl.useProgram(program.handle);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,input.handle);
      gl.uniform1i(this.uniform(program,'source'),0);gl.uniform2i(this.uniform(program,'imageSize'),input.w,input.h);
      configure?.(gl);gl.viewport(0,0,w,h);gl.drawArrays(gl.TRIANGLES,0,3);
    }
    read(w,h){
      const gl=this.gl,pixels=new Float32Array(w*h*4),started=performance.now();
      try{gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,pixels);}
      finally{this.stats.gpuReadbackMilliseconds+=performance.now()-started;}
      const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('GPU compute failed at readback (WebGL 0x'+error.toString(16)+')');return pixels;
    }
    run(operation){
      if(!this.gl)return null;
      const started=performance.now();
      try{if(this.gl.isContextLost())throw Error('GPU context lost');return operation();}
      catch(error){this.disable(error);return null;}
      finally{this.stats.gpuMilliseconds+=performance.now()-started;}
    }
    spectrum(luma,w,h,stride,fw,fh){if(fw<4)return null;return this.run(()=>{
      const gl=this.gl;if(Math.max(w,h,fw,fh)>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw Error('GPU texture size exceeded');
      this.upload(luma,w,h);let current=0;
      this.draw(this.init,this.luma,this.complex[current],fw,fh,g=>{
        g.uniform2i(this.uniform(this.init,'sampledSize'),Math.ceil(w/stride),Math.ceil(h/stride));
        g.uniform2i(this.uniform(this.init,'bits'),Math.log2(fw),Math.log2(fh));g.uniform1i(this.uniform(this.init,'stride'),stride);
      });
      for(const [axis,length] of [[0,fw],[1,fh]])for(let span=2;span<=length;span*=2){
        this.draw(this.fft,this.complex[current],this.complex[1-current],fw,fh,g=>{
          g.uniform1i(this.uniform(this.fft,'axis'),axis);g.uniform1i(this.uniform(this.fft,'span'),span);
        });current=1-current;
      }
      // Pack four adjacent scalar powers into RGBA: one readback, one float
      // per FFT bin, with the same row-major layout as the CPU spectrum.
      this.draw(this.power,this.complex[current],this.packed,fw/4,fh);
      const values=this.read(fw/4,fh);this.stats.gpuFfts++;return values;
    });}
    candidates(luma,w,h,basis,adapter,options){
      const skip=w>512||h>512?'pilot tile exceeds 512 pixels':adapter.ids.length!==4?'marker format needs CPU pilots':
        options.region?'restricted pilot region needs CPU':options.mode==='padding'?'padding pilots need CPU':
        options.edgeBand&&options.edgeBand<.5?'edge-band pilots need CPU':null;
      if(skip){this.stats.gpuSkippedPilots++;this.stats.gpuPilotSkipReason=skip;return null;}
      return this.run(()=>{
        this.upload(luma,w,h);const taps=[],spacing=adapter.sampleStep??1.5,offset=adapter.sampleOffset??.5;
        for(let y=0;y<4;y++)for(let x=0;x<4;x++)taps.push(basis[0]*(spacing*x+offset)+basis[2]*(spacing*y+offset),
          basis[1]*(spacing*x+offset)+basis[3]*(spacing*y+offset),adapter.shape[x+y*4]);
        this.draw(this.wavelet,this.luma,this.field,w,h,g=>g.uniform3fv(this.uniform(this.wavelet,'taps[0]'),new Float32Array(taps)));
        const points=[],signs=[];
        for(let i=0;i<24;i++){
          const p=adapter.pilots[0].points[i];points.push(basis[0]*p.x+basis[2]*p.y,basis[1]*p.x+basis[3]*p.y);
          for(let id=0;id<4;id++)signs.push(adapter.pilots[id].points[i].sign);
        }
        const scanStep=2,sw=Math.ceil(w/scanStep),sh=Math.ceil(h/scanStep);
        this.draw(this.pilot,this.field,this.scores,sw,sh,g=>{
          g.uniform2fv(this.uniform(this.pilot,'points[0]'),new Float32Array(points));
          g.uniform4fv(this.uniform(this.pilot,'signs[0]'),new Float32Array(signs));g.uniform1i(this.uniform(this.pilot,'scanStep'),scanStep);
        });
        const values=this.read(sw,sh);this.stats.gpuPilots++;return {values,width:sw,height:sh,step:scanStep};
      });
    }
    disable(error){
      if(this.gl){for(const t of this.textures)this.gl.deleteTexture(t);for(const p of this.programs)this.gl.deleteProgram(p);
        if(this.framebuffer)this.gl.deleteFramebuffer(this.framebuffer);if(this.vao)this.gl.deleteVertexArray(this.vao);
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();}
      this.gl=null;this.lastLuma=null;this.stats.backend='CPU fallback';this.stats.gpuUnavailable=error?.message||'GPU compute unavailable';
    }
    begin(){
      for(const key of ['gpuFfts','gpuPilots','gpuMilliseconds','gpuReadbackMilliseconds','gpuSkippedPilots'])this.stats[key]=0;
      this.stats.gpuPilotSkipReason=null;this.stats.gpuInitMilliseconds=this.pendingInitMilliseconds;this.pendingInitMilliseconds=0;
    }
    end(){this.lastLuma=null;}
  }
  root.MarkerSearchGpu=SearchGpu;
})(self);
