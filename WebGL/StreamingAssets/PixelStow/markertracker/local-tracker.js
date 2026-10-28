// Copyright 2026 massivehadron.com ltd.

// Lab-only planar tracking. A verified acquisition supplies the identity; this
// follows its fixed image template without repeating marker/payload discovery.
(function (root) {
  "use strict";
  const SIZE = 128, PATCH = 80, PAD = 24;
  const WIDE = 512;
  // Sequential fits share scratch storage. Avoid thousands of short-lived
  // per-pixel arrays on each phone frame (and the resulting GC pauses).
  const samples = new Float64Array(PATCH * PATCH * 9);
  const multiply = (a, b) => Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3), c = i % 3;
    return a[r * 3] * b[c] + a[r * 3 + 1] * b[c + 3] + a[r * 3 + 2] * b[c + 6];
  });
  const point = (h, x, y) => {
    const z = h[6] * x + h[7] * y + h[8];
    return { x: (h[0] * x + h[1] * y + h[2]) / z, y: (h[3] * x + h[4] * y + h[5]) / z };
  };
  function solve(a, b, n) {
    a = a.slice(); b = b.slice();
    for (let k = 0; k < n; k++) {
      let pivot = k;
      for (let j = k + 1; j < n; j++) if (Math.abs(a[j * n + k]) > Math.abs(a[pivot * n + k])) pivot = j;
      if (Math.abs(a[pivot * n + k]) < 1e-8) return null;
      for (let j = k; j < n; j++) [a[k * n + j], a[pivot * n + j]] = [a[pivot * n + j], a[k * n + j]];
      [b[k], b[pivot]] = [b[pivot], b[k]];
      const divisor = a[k * n + k];
      for (let j = k; j < n; j++) a[k * n + j] /= divisor;
      b[k] /= divisor;
      for (let i = 0; i < n; i++) if (i !== k) {
        const f = a[i * n + k];
        for (let j = k; j < n; j++) a[i * n + j] -= f * a[k * n + j];
        b[i] -= f * b[k];
      }
    }
    return b;
  }
  function pyramid(rgba, existing) {
    const first = existing?.[0] || { w: SIZE, data: new Float32Array(SIZE * SIZE), valid: new Uint8Array(SIZE * SIZE) };
    for (let i = 0; i < first.data.length; i++) {
      first.data[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
      first.valid[i] = rgba[i * 4 + 3] === 255 ? 1 : 0;
    }
    const levels = existing || [first];
    for (let level = 1; level < 3; level++) {
      const p = levels[level - 1], w = p.w / 2;
      const data = levels[level]?.data || new Float32Array(w * w), valid = levels[level]?.valid || new Uint8Array(w * w);
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const i = x * 2 + y * 2 * p.w, j = x + y * w;
        data[j] = (p.data[i] + p.data[i + 1] + p.data[i + p.w] + p.data[i + p.w + 1]) / 4;
        valid[j] = p.valid[i] & p.valid[i + 1] & p.valid[i + p.w] & p.valid[i + p.w + 1];
      }
      if (!levels[level]) levels[level] = { w, data, valid };
    }
    return levels;
  }
  function sample(image, x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), w = image.w;
    if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= w - 1) return NaN;
    const i = ix + iy * w;
    if (!(image.valid[i] & image.valid[i + 1] & image.valid[i + w] & image.valid[i + w + 1])) return NaN;
    const a = x - ix, b = y - iy, d = image.data;
    return (d[i] * (1 - a) + d[i + 1] * a) * (1 - b) + (d[i + w] * (1 - a) + d[i + w + 1] * a) * b;
  }
  function measurements(reference, image, p, level, stride = 1) {
    const f = 2 ** level, span = PATCH / f, centre = (image.w - 1) / 2;
    const low = Math.ceil(PAD / f + 1), high = Math.floor((PAD + PATCH) / f - 2);
    let st = 0, sc = 0, tt = 0, cc = 0, tc = 0, total = 0, n = 0;
    for (let y = low; y <= high; y += stride) for (let x = low; x <= high; x += stride) {
      total++;
      const u = (x - centre) / span, v = (y - centre) / span, z = p[6] * u + p[7] * v + 1;
      const nx = (p[0] * u + p[1] * v + p[2]) / z, ny = (p[3] * u + p[4] * v + p[5]) / z;
      const sx = centre + span * nx, sy = centre + span * ny;
      const c = sample(image, sx, sy), t = reference.data[x + y * image.w];
      if (!Number.isFinite(c) || !reference.valid[x + y * image.w]) continue;
      const i=n++*9;
      samples[i]=u;samples[i+1]=v;samples[i+2]=z;samples[i+3]=nx;samples[i+4]=ny;
      samples[i+5]=sx;samples[i+6]=sy;samples[i+7]=c;samples[i+8]=t;
      st += t; sc += c; tt += t * t; cc += c * c; tc += t * c;
    }
    const vt = tt - st * st / n, vc = cc - sc * sc / n, cov = tc - st * sc / n;
    const correlation = n && vt > n * .04 && vc > n * .04 ? cov / Math.sqrt(vt * vc) : -1;
    return { n, span, correlation, coverage: n / Math.max(1, total), gain: cov / Math.max(vc, .001),
      bias: (st - cov / Math.max(vc, .001) * sc) / n };
  }
  function translationScore(reference, image, dx, dy) {
    let n=0,st=0,sc=0,tt=0,cc=0,tc=0,total=0;
    for(let y=7;y<=24;y+=2)for(let x=7;x<=24;x+=2){
      total++;const xx=x+dx,yy=y+dy;
      if(xx<0||yy<0||xx>=image.w||yy>=image.w||!image.valid[xx+yy*image.w]||!reference.valid[x+y*32])continue;
      const t=reference.data[x+y*32],c=image.data[xx+yy*image.w];n++;st+=t;sc+=c;tt+=t*t;cc+=c*c;tc+=t*c;
    }
    if(n<total*.9)return -1;
    const vt=tt-st*st/n,vc=cc-sc*sc/n;
    return vt>n*.04&&vc>n*.04?(tc-st*sc/n)/Math.sqrt(vt*vc):-1;
  }
  function align(reference, current) {
    let bestScore=-1,bestX=0,bestY=0;
    // A coarse translation search avoids re-running a global frequency search
    // after camera motion. Its work is independent of camera resolution.
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
      const score=translationScore(reference[2],current[2],x,y);
      if(score>bestScore){bestScore=score;bestX=x;bestY=y;}
    }
    if (bestScore < .25) return null;
    const p = [1,0,bestX/20,0,1,bestY/20,0,0];
    for (let level = 2; level >= 0; level--) for (let iteration = 0; iteration < 10; iteration++) {
      const m = measurements(reference[level], current[level], p, level, level === 0 ? 2 : 1);
      if (m.coverage < .85 || !Number.isFinite(m.gain) || m.gain < .2 || m.gain > 5) return null;
      const a = new Float64Array(64), b = new Float64Array(8), j = new Float64Array(8);
      for (let index=0;index<m.n*9;index+=9) {
        const u=samples[index],v=samples[index+1],z=samples[index+2],nx=samples[index+3],ny=samples[index+4];
        const sx=samples[index+5],sy=samples[index+6],c=samples[index+7],t=samples[index+8];
        const gx = (sample(current[level], sx + .6, sy) - sample(current[level], sx - .6, sy)) / 1.2;
        const gy = (sample(current[level], sx, sy + .6) - sample(current[level], sx, sy - .6)) / 1.2;
        if (!Number.isFinite(gx + gy)) continue;
        const ix = gx * m.gain * m.span / z, iy = gy * m.gain * m.span / z;
        j[0]=ix*u;j[1]=ix*v;j[2]=ix;j[3]=iy*u;j[4]=iy*v;j[5]=iy;j[6]=-(ix*nx+iy*ny)*u;j[7]=-(ix*nx+iy*ny)*v;
        const residual = m.gain * c + m.bias - t, weight = Math.min(1, 12 / Math.max(1, Math.abs(residual)));
        for (let r = 0; r < 8; r++) {
          b[r] += weight * j[r] * residual;
          for (let k = 0; k < 8; k++) a[r * 8 + k] += weight * j[r] * j[k];
        }
      }
      for (let i = 0; i < 8; i++) a[i * 8 + i] += .01;
      const delta = solve(a, b, 8);
      if (!delta) return null;
      let norm = 0;
      for (let i = 0; i < 8; i++) { p[i] -= delta[i]; norm += delta[i] ** 2; }
      if (p.some(v => !Number.isFinite(v)) || Math.abs(p[2]) > .45 || Math.abs(p[5]) > .45 || Math.abs(p[6]) > .7 || Math.abs(p[7]) > .7) return null;
      if (norm < .0000001) break;
    }
    const fit = measurements(reference[0], current[0], p, 0, 2);
    if (fit.coverage < .95 || fit.correlation < .85) return null;
    return { p, score: fit.correlation };
  }
  function fittedPose(base,p,marker){
    const c=(SIZE-1)/2,s=PATCH;
    const d=multiply([s,0,c,0,s,c,0,0,1],multiply([...p,1],[1/s,0,-c/s,0,1/s,-c/s,0,0,1]));
    const sx=(PATCH-1)/(marker.patchWidth-1),sy=(PATCH-1)/(marker.patchHeight-1);
    const h=multiply(base,multiply([1/sx,0,-PAD/sx,0,1/sy,-PAD/sy,0,0,1],multiply(d,[sx,0,PAD,0,sy,PAD,0,0,1])));
    return h.map(v=>v/h[8]);
  }
  function wideCandidates(reference, rgba, existing) {
    const w=WIDE/4,image=existing||{w,data:new Float32Array(w*w),valid:new Uint8Array(w*w)};
    for(let y=0;y<w;y++)for(let x=0;x<w;x++){
      let sum=0,valid=1;
      for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){
        const i=((y*4+dy)*WIDE+x*4+dx)*4;sum+=rgba[i]+rgba[i+1]+rgba[i+2];valid&=rgba[i+3]===255;
      }
      image.data[x+y*w]=sum/48;image.valid[x+y*w]=valid;
    }
    const offset=(WIDE-SIZE)/8,reach=offset+4,peaks=[];
    // The full marker, not just an overlapping fragment, must be in this window.
    for(let dy=-reach;dy<=reach;dy+=2)for(let dx=-reach;dx<=reach;dx+=2)
      peaks.push({dx,dy,score:translationScore(reference[2],image,offset+dx,offset+dy)});
    peaks.sort((a,b)=>b.score-a.score);
    const candidates=[];
    for(const peak of peaks){
      if(peak.score<.25||candidates.length>=6)break;
      if(candidates.some(p=>Math.hypot(p.dx-peak.dx,p.dy-peak.dy)<5))continue;
      let best=peak;
      for(let dy=peak.dy-1;dy<=peak.dy+1;dy++)for(let dx=peak.dx-1;dx<=peak.dx+1;dx++){
        const score=translationScore(reference[2],image,offset+dx,offset+dy);if(score>best.score)best={dx,dy,score};
      }
      candidates.push(best);
    }
    return {image,candidates};
  }
  class Sampler {
    constructor() {
      this.canvas = document.createElement("canvas"); this.canvas.width = this.canvas.height = SIZE;
      const gl = this.canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false });
      if (!gl) throw new Error("GPU tracking needs WebGL. Enable browser graphics acceleration and reload.");
      this.gl = gl;
      const shader = (type, source) => {
        const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const vertex = shader(gl.VERTEX_SHADER, "attribute vec2 a; void main(){gl_Position=vec4(a,0.,1.);}");
      const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float;
        uniform sampler2D frame; uniform mat3 pose; uniform vec2 imageSize; uniform vec2 patchSize; uniform float pad;
        void main(){
          vec2 q=(gl_FragCoord.xy-vec2(.5+pad))*patchSize/${PATCH - 1}.;
          vec3 p=pose*vec3(q,1.); vec2 xy=p.xy/p.z;
          if(xy.x<0.||xy.y<0.||xy.x>imageSize.x-1.||xy.y>imageSize.y-1.){gl_FragColor=vec4(0.);return;}
          gl_FragColor=vec4(texture2D(frame,vec2((xy.x+.5)/imageSize.x,1.-(xy.y+.5)/imageSize.y)).rgb,1.);
        }`);
      const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      this.program = program; gl.deleteShader(vertex); gl.deleteShader(fragment); gl.useProgram(program);
      this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, "a"); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, name, gl.LINEAR);
      for (const name of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, name, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.disable(gl.DITHER);
      this.pose = gl.getUniformLocation(program, "pose"); this.imageSize = gl.getUniformLocation(program, "imageSize");
      this.patchSize = gl.getUniformLocation(program, "patchSize"); this.pixels = new Uint8Array(SIZE * SIZE * 4);
      this.pad=gl.getUniformLocation(program,"pad");this.widePixels=new Uint8Array(WIDE*WIDE*4);
    }
    upload(source) {
      const gl = this.gl;
      if (gl.isContextLost()) throw new Error("GPU tracking context lost. Close and reopen the camera.");
      gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform2f(this.imageSize, source.videoWidth || source.width, source.videoHeight || source.height);
    }
    read(source, matrix, patchWidth, patchHeight, wide=false) {
      const gl = this.gl;
      const size=wide?WIDE:SIZE,pixels=wide?this.widePixels:this.pixels;
      if(this.canvas.width!==size){this.canvas.width=this.canvas.height=size;}
      if (source) this.upload(source);
      gl.uniform1f(this.pad,(size-PATCH)/2);
      gl.uniform2f(this.patchSize, patchWidth - 1, patchHeight - 1);
      gl.uniformMatrix3fv(this.pose, false, new Float32Array([matrix[0],matrix[3],matrix[6],matrix[1],matrix[4],matrix[7],matrix[2],matrix[5],matrix[8]]));
      gl.viewport(0, 0, size, size); gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }
    dispose() {
      const gl = this.gl; gl.deleteTexture(this.texture); gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  class LocalTracker {
    constructor(sampler) { this.sampler = sampler || new Sampler(); this.ownsSampler = !sampler; this.marker = null; }
    acquire(source, marker, time = performance.now(), pose = marker.matrix) {
      const width = marker.patchWidth || 50, height = marker.patchHeight || 50;
      this.reference = pyramid(this.sampler.read(source, marker.matrix, width, height));
      this.marker = { ...marker, matrix: pose.slice(), patchWidth: width, patchHeight: height };
      this.lastSeen = time; this.misses = 0; this.score = 1;
      this.previousCentre = null; this.previousTime = time; this.confirmedFrames=0;
    }
    reframe(dx, dy) {
      if (!this.marker) return;
      const h = this.marker.matrix;
      this.marker.matrix = h.map((v, i) => i < 3 ? v + dx * h[i + 6] : i < 6 ? v + dy * h[i + 3] : v);
      if (this.previousCentre) {this.previousCentre.x+=dx;this.previousCentre.y+=dy;}
    }
    update(source, time = performance.now(), proposal = null, recover = true) {
      if (!this.marker) return null;
      const started = performance.now(), marker = this.marker;
      let base=proposal || marker.matrix, sampledPixels=SIZE*SIZE;
      const centre=point(marker.matrix,(marker.patchWidth-1)/2,(marker.patchHeight-1)/2);
      if (!proposal && this.previousCentre && this.lastSeen>this.previousTime) {
        const elapsed=Math.min(3,Math.max(0,(time-this.lastSeen)/(this.lastSeen-this.previousTime)));
        const dx=(centre.x-this.previousCentre.x)*elapsed,dy=(centre.y-this.previousCentre.y)*elapsed;
        base=base.map((v,i)=>i<3?v+dx*base[i+6]:i<6?v+dy*base[i+3]:v);
      }
      this.current=pyramid(this.sampler.read(source, base, marker.patchWidth, marker.patchHeight),this.current);
      let fit = align(this.reference, this.current);
      if(!fit && recover){
        const wide=wideCandidates(this.reference,this.sampler.read(null,marker.matrix,marker.patchWidth,marker.patchHeight,true),this.wide);
        this.wide=wide.image;sampledPixels+=WIDE*WIDE;
        for(const {dx,dy} of wide.candidates){
          base=multiply(marker.matrix,[1,0,dx*4*(marker.patchWidth-1)/(PATCH-1),0,1,dy*4*(marker.patchHeight-1)/(PATCH-1),0,0,1]);
          this.current=pyramid(this.sampler.read(null,base,marker.patchWidth,marker.patchHeight),this.current);sampledPixels+=SIZE*SIZE;
          fit=align(this.reference,this.current);
          if(fit){
            // A wide jump can land on another ID with a very similar texture.
            // Re-read this ID's CRC from one rectified GPU tile before accepting.
            const pose=fittedPose(base,fit.p,marker),pixels=this.sampler.read(null,pose,marker.patchWidth,marker.patchHeight);
            sampledPixels+=SIZE*SIZE;
            const sx=(PATCH-1)/(marker.patchWidth-1),sy=(PATCH-1)/(marker.patchHeight-1);
            const read=root.PixelStow.readVisualMarker(pixels,SIZE,SIZE,{...marker,matrix:[sx,0,PAD,0,sy,PAD,0,0,1]});
            if(read)break;fit=null;
          }
        }
      }
      if (fit) {
        this.marker = { ...marker, matrix: fittedPose(base,fit.p,marker), ghost: false };
        // The first fit corrects acquisition geometry; it is not camera velocity.
        this.previousCentre=this.confirmedFrames++?centre:null; this.previousTime=this.lastSeen;
        this.lastSeen = time; this.misses = 0; this.score = fit.score;
      } else { this.misses++; this.score = 0; }
      const current = this.marker, w = current.patchWidth - 1, h = current.patchHeight - 1;
      const lost = time - this.lastSeen > 350;
      return { marker: current, locked: Boolean(fit), lost, score: this.score, misses: this.misses,
        milliseconds: performance.now() - started, sampledPixels,
        squares: lost ? [] : [{ id: current.id, ghost: !fit, corners: [[0,0],[w,0],[w,h],[0,h]].map(([x,y]) => point(current.matrix,x,y)) }] };
    }
    dispose() { if (this.ownsSampler) this.sampler.dispose(); this.marker = this.reference = this.current = null; }
  }
  class TrackerBank {
    constructor() { this.sampler = new Sampler(); this.items = new Map(); this.recoveryCursor=0; }
    acquire(source, marker, time = performance.now(), pose = marker.matrix) {
      if (this.items.has(marker.id)) return false;
      const tracker = new LocalTracker(this.sampler); tracker.acquire(source, marker, time, pose);
      this.items.set(marker.id, tracker); return true;
    }
    get size() { return this.items.size; }
    get markers() { return [...this.items.values()].map(t => t.marker); }
    reframe(dx, dy) { for (const t of this.items.values()) t.reframe(dx, dy); }
    update(source, time = performance.now()) {
      this.sampler.upload(source);
      const items=[...this.items.values()],start=this.recoveryCursor%Math.max(1,items.length);
      const ordered=items.slice(start).concat(items.slice(0,start));
      const results=[],before=ordered.map(t=>t.marker.matrix.slice());
      let motion=null,index=0,recovered=false,guide=false;
      for(const tracker of ordered){
        const result=tracker.update(null,time,guide&&multiply(motion,before[index]),!recovered);
        if(result.sampledPixels>SIZE*SIZE)recovered=true;
        if(result.locked&&!motion){
          const x=(tracker.marker.patchWidth-1)/2,y=(tracker.marker.patchHeight-1)/2;
          const a=point(before[index],x,y),b=point(result.marker.matrix,x,y),dx=b.x-a.x,dy=b.y-a.y;
          motion=[1,0,dx,0,1,dy,0,0,1];
          // Do not extrapolate tiny patch perspective noise across the picture.
          guide=recovered||Math.hypot(dx,dy)>Math.hypot(a.x-point(before[index],0,y).x,a.y-point(before[index],0,y).y)*.5;
        }
        results.push(result);index++;
      }
      // A surviving corner can also rescue an earlier occluded/missed corner.
      if(motion){index=0;for(const tracker of ordered){
        if(!results[index].locked){const retry=tracker.update(null,time,multiply(motion,before[index]),false);
          retry.milliseconds+=results[index].milliseconds;retry.sampledPixels+=results[index].sampledPixels;results[index]=retry;}
        index++;
      }}
      // An occluded first ID must not consume every frame's recovery allowance.
      if(recovered&&!motion)this.recoveryCursor=(start+1)%Math.max(1,items.length);
      return results;
    }
    remove(id) { this.items.get(id)?.dispose(); this.items.delete(id); }
    dispose() { for (const t of this.items.values()) t.dispose(); this.items.clear(); this.sampler.dispose(); }
  }
  root.MarkerLocalTracker = LocalTracker;
  root.MarkerTrackerBank = TrackerBank;
})(typeof window !== "undefined" ? window : self);
