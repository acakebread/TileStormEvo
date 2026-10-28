// Copyright 2026 massivehadron.com ltd.

/* Low-contrast V5 calibration hint. It is never proof of a readable payload.
 * The profile is a carrier-format detail: keep these pitches, phases, placement
 * and integer rounding stable so apply(..., {inverse:true}) can remove it.
 * scale is capture pixels per native carrier pixel. fx/fy deliberately use the
 * existing transform's 1/(128*scale) convention, not the physical guide pitch.
 */
(function(root) {
  'use strict';
  const TAU=Math.PI*2, BAND=48, INSET=8, NORMAL=24, PITCHES=[64,96], PHASES=[.31,1.19], LIMIT=2;
  const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
  const clamp=value=>Math.max(0,Math.min(255,value));
  function reservations(w,h) {
    const xs=[8,4*Math.floor((w-60)/4)],ys=[8,4*Math.floor((h-60)/4)];
    const result=[];for(const x of xs)for(const y of ys)result.push({x,y,w:52,h:52});
    const mx=Math.floor((w-24)/8)*4,my=Math.floor((h-16)/8)*4;
    result.push({x:mx,y:8,w:24,h:16},{x:8,y:my,w:24,h:16},{x:Math.floor((w-32)/4)*4,y:my,w:24,h:16},{x:mx,y:Math.floor((h-24)/4)*4,w:24,h:16});
    return result;
  }
  function apply(pixels,w,h,options={}) {
    if(!Number.isInteger(w)||!Number.isInteger(h)||pixels.length!==w*h*4)throw new Error('Invalid edge-guide image.');
    const output=new Uint8Array(pixels),reserved=reservations(w,h),sign=options.inverse?-1:1;
    if(w<256||h<192)return output;
    const waves=Float64Array.from({length:Math.max(w,h)},(_,x)=>Math.cos(TAU*x/64+PHASES[0])+Math.cos(TAU*x/96+PHASES[1]));
    const envelope=Float64Array.from({length:BAND},(_,d)=>Math.sin(Math.PI*(d+.5)/BAND)*Math.cos(TAU*d/NORMAL+.43));
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      let normal=-1,tangent;
      if(x>=64&&x<w-64) {
        if(y>=INSET&&y<INSET+BAND){normal=y-INSET;tangent=x;}
        else if(y>=h-INSET-BAND&&y<h-INSET){normal=h-INSET-1-y;tangent=x;}
      }
      if(normal<0&&y>=64&&y<h-64) {
        if(x>=INSET&&x<INSET+BAND){normal=x-INSET;tangent=y;}
        else if(x>=w-INSET-BAND&&x<w-INSET){normal=w-INSET-1-x;tangent=y;}
      }
      if(normal<0||reserved.some(r=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h))continue;
      const delta=sign*Math.max(-LIMIT,Math.min(LIMIT,Math.round(waves[tangent]*envelope[normal]))),i=(x+y*w)*4;
      output[i]=clamp(output[i]+delta);output[i+1]=clamp(output[i+1]-delta);output[i+2]=clamp(output[i+2]+delta);
    }
    return output;
  }
  const angleDistance=value=>Math.abs(Math.atan2(Math.sin(value),Math.cos(value)));
  const polygonArea=points=>Math.abs(points.reduce((sum,point,i)=>{
    const next=points[(i+1)%points.length];return sum+point.x*next.y-next.x*point.y;
  },0))/2;
  function tangentSpans(N,start,stop) {
    const spans=[],add=(a,b)=>{
      a=Math.max(0,Math.min(N-24,Math.round(a)));b=Math.max(a+24,Math.min(N,Math.round(b)));
      if(b-a<24||spans.some(([u,v])=>Math.abs(u-a)<2&&Math.abs(v-b)<2))return;
      spans.push([a,b]);
    };
    add(start,stop);
    for(const inset of [.12,.24])add(N*inset,N*(1-inset));
    add(N*.16,N);add(0,N*.84);add(N*.14,N*.86);
    return spans;
  }
  function scanAxis(q,scale,vertical,check) {
    const {data,w,h,reduction}=q,N=vertical?h:w,M=vertical?w:h;
    const start=Math.round(64*scale/reduction),stop=N-start,L=Math.round(BAND*scale/reduction);
    if(stop<start+16||L<4||M<L)return [];
    const state=q.axes[vertical?1:0],{rs,basis,prefix}=state,stride=(N+1)*4;
    for(let x=0;x<N;x++) {
      const a=TAU*(x+.5)*reduction/(64*scale),b=TAU*(x+.5)*reduction/(96*scale),i=x*4;
      basis[i]=Math.cos(a);basis[i+1]=Math.sin(a);basis[i+2]=Math.cos(b);basis[i+3]=Math.sin(b);
    }
    for(let y=0;y<M;y++) {
      if((y&63)===0)check();
      const row=y*stride;let a=0,b=0,c=0,d=0;
      for(let x=0;x<N;x++) {
        const value=vertical?data[y+x*w]:data[x+y*w],j=x*4,to=row+(x+1)*4;
        a+=value*basis[j];b+=value*basis[j+1];c+=value*basis[j+2];d+=value*basis[j+3];
        prefix[to]=a;prefix[to+1]=b;prefix[to+2]=c;prefix[to+3]=d;
      }
    }
    const kernel=new Float64Array(L);let mean=0,slope=0,energy=0;
    for(let j=0;j<L;j++) {
      const d=(j+.5)*reduction/scale-.5;
      kernel[j]=Math.sin(Math.PI*(d+.5)/BAND)*Math.cos(TAU*d/NORMAL+.43);mean+=kernel[j];
    }
    mean/=L;
    for(let j=0;j<L;j++)slope+=(j-(L-1)/2)*(kernel[j]-mean);
    slope/=L*(L*L-1)/12;
    for(let j=0;j<L;j++){kernel[j]-=mean+slope*(j-(L-1)/2);energy+=kernel[j]*kernel[j];}
    state.kernel=kernel;state.energy=energy;
    const found=[];
    // A toolbar, bezel or other surround must not be averaged into the guide.
    // A known picture is one span. An unknown frame also tries the picture's
    // own span, centred and with one side left out.
    const spans=q.knownBounds?[[start,stop]]:tangentSpans(N,start,stop);
    for(const [spanStart,spanStop] of spans) {
      const spanNorm=2/(spanStop-spanStart);
      for(let y=0;y<M;y++) {
        const row=y*stride,i=y*4;
        for(let k=0;k<4;k++)rs[i+k]=(prefix[row+spanStop*4+k]-prefix[row+spanStart*4+k])*spanNorm;
      }
      for(let y=0;y<=M-L;y++)for(let direction=0;direction<2;direction++) {
        if(q.knownBounds&&Math.min(Math.abs(y-INSET*scale/reduction),Math.abs(y-(M-(INSET+BAND)*scale/reduction)))>2.5)continue;
        let a=0,b=0,c=0,d=0;
        for(let j=0;j<L;j++) {
          const value=kernel[direction?L-1-j:j]/energy,i=(y+j)*4;
          a+=rs[i]*value;b+=rs[i+1]*value;c+=rs[i+2]*value;d+=rs[i+3]*value;
        }
        const amplitude=[Math.hypot(a,b),Math.hypot(c,d)],phase=[Math.atan2(b,a),Math.atan2(d,c)];
        const closure=angleDistance(2*phase[0]-3*phase[1]-(6*PHASES[1]-4*PHASES[0])/2),score=Math.min(...amplitude);
        if(q.diagnostic&&score>0&&(!q.diagnostic.strongest||score>q.diagnostic.strongest.score)) {
          const points=vertical?[[y,spanStart],[y+L,spanStart],[y+L,spanStop],[y,spanStop]]:
            [[spanStart,y],[spanStop,y],[spanStop,y+L],[spanStart,y+L]];
          q.diagnostic.strongest={score,scale,amplitude,phaseError:closure,axis:vertical?'vertical':'horizontal',
            band:points.map(([x,y])=>q.map?q.map(x/q.w,y/q.h):{x:x*reduction-.5,y:y*reduction-.5}),
            reason:score<=(q.knownBounds?.3:.5)?'weak response':closure>=(q.knownBounds?Math.PI:1.1)?'phase mismatch':'no matching set of edges'};
        }
        if(score>(q.knownBounds?.3:.5)&&closure<(q.knownBounds?Math.PI:1.1))found.push({position:y,direction,amplitude,phase,closure,score});
      }
    }
    found.sort((a,b)=>b.score-a.score);const separated=[];
    for(const value of found)if(!separated.some(previous=>previous.direction===value.direction&&Math.abs(previous.position-value.position)<L*.3))separated.push(value);
    return separated.slice(0,40);
  }
  function measureStrip(q,scale,vertical,strip,start,stop) {
    const {w,h}=q,N=vertical?h:w,state=q.axes[vertical?1:0],{kernel,energy,prefix}=state,L=kernel.length,stride=(N+1)*4;
    start=Math.max(0,Math.ceil(start));stop=Math.min(N,Math.floor(stop));
    if(stop-start<24)return null;
    const z=[0,0,0,0];
    for(let j=0;j<L;j++) {
      const y=strip.position+j,weight=kernel[strip.direction?L-1-j:j]/energy,from=y*stride+start*4,to=y*stride+stop*4;
      for(let k=0;k<4;k++)z[k]+=(prefix[to+k]-prefix[from+k])*weight;
    }
    const amplitude=[Math.hypot(z[0],z[1]),Math.hypot(z[2],z[3])].map(value=>value*2/(stop-start));
    return {...strip,amplitude,phase:[Math.atan2(z[1],z[0]),Math.atan2(z[3],z[2])],score:Math.min(...amplitude)};
  }
  function stripNoise(q,scale,vertical,strip,start,stop) {
    const {data,w,h,reduction}=q,N=vertical?h:w,{kernel,energy}=q.axes[vertical?1:0],L=kernel.length;
    start=Math.max(0,Math.ceil(start));stop=Math.min(N,Math.floor(stop));
    const key=[vertical,strip.position,strip.direction,start,stop].join(','),cache=q.noiseCache;
    if(cache.has(key))return cache.get(key);
    const values=new Float64Array(stop-start);
    for(let j=0;j<L;j++) {
      const y=strip.position+j,weight=kernel[strip.direction?L-1-j:j]/energy;
      for(let x=start;x<stop;x++)values[x-start]+=(vertical?data[y+x*w]:data[x+y*w])*weight;
    }
    const result=PITCHES.map(pitch=> {
      const samples=[];
      for(const offset of [-6.5,-4.5,-1.5,1.5,4.5,6.5]) {
        const step=TAU*(reduction/(pitch*scale)+offset/values.length),cr=Math.cos(step),ci=Math.sin(step);
        let re=0,im=0,cs=Math.cos(step*(start+.5)),sn=Math.sin(step*(start+.5));
        for(const value of values){re+=value*cs;im+=value*sn;const next=cs*cr-sn*ci;sn=sn*cr+cs*ci;cs=next;}
        samples.push(2*Math.hypot(re,im)/values.length);
      }
      samples.sort((a,b)=>a-b);return Math.max(.04,samples[3]);
    });
    cache.set(key,result);return result;
  }
  function matchFrame(q,scale,check) {
    q.noiseCache=new Map();
    const sides=[scanAxis(q,scale,false,check),scanAxis(q,scale,true,check)],pairs=[];
    for(let axis=0;axis<2;axis++) {
      const candidates=[],values=sides[axis],dimension=axis===0?q.h:q.w;
      for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++) {
        const a=values[i],b=values[j],first=a.position<b.position?a:b;
        if(Math.abs(a.position-b.position)<dimension*.5)continue;
        if(q.knownBounds&&(Math.abs(first.position-INSET*scale/q.reduction)>2.5||
          Math.abs((first===a?b:a).position-(dimension-(INSET+BAND)*scale/q.reduction))>2.5))continue;
        const coherence=Math.max(...a.phase.map((value,k)=>angleDistance(value-b.phase[k])));
        const closest=Math.min(...a.phase.map((phase,k)=>angleDistance(phase-b.phase[k])));
        if(q.knownBounds?closest>.6:coherence>.4)continue;
        const score=Math.min(a.score,b.score);
        candidates.push({score,coherence,first,second:first===a?b:a});
      }
      pairs.push(candidates.sort((a,b)=>b.score-a.score).slice(0,30));
    }
    let best=null;
    for(const horizontal of pairs[0])for(const vertical of pairs[1]) {
      check();
      const sx=vertical.first.position+(64-INSET)*scale/q.reduction,ex=vertical.second.position+(INSET+BAND-64)*scale/q.reduction;
      const sy=horizontal.first.position+(64-INSET)*scale/q.reduction,ey=horizontal.second.position+(INSET+BAND-64)*scale/q.reduction;
      const measured=[{...horizontal,first:measureStrip(q,scale,false,horizontal.first,sx,ex),second:measureStrip(q,scale,false,horizontal.second,sx,ex)},
        {...vertical,first:measureStrip(q,scale,true,vertical.first,sy,ey),second:measureStrip(q,scale,true,vertical.second,sy,ey)}];
      if(measured.some(pair=>!pair.first||!pair.second))continue;
      // The captured image can have any quarter-turn. Reversing a tangent
      // reverses its fixed phase as well; rotating a display box cannot fix
      // that measurement. Verify each physical orientation on the same data.
      for(let turn=0;turn<4;turn++) {
        const phaseErrors=[],coherences=[],amplitudes=[];
        for(let axis=0;axis<2;axis++) {
          const perpendicular=axis===0?vertical:horizontal,unit=scale/q.reduction;
          const reversed=axis===0?turn===1||turn===2:turn===2||turn===3;
          const origin=reversed?perpendicular.second.position+(INSET+BAND-.5)*unit:
            perpendicular.first.position-(INSET-.5)*unit;
          const expected=PITCHES.map((pitch,i)=>(reversed?PHASES[i]:-PHASES[i])+TAU*origin/(pitch*unit));
          const pair=measured[axis];
          for(const strip of [pair.first,pair.second])for(let k=0;k<2;k++) {
            phaseErrors.push(angleDistance(strip.phase[k]-expected[k]));amplitudes.push(strip.amplitude[k]);
          }
          coherences.push(...pair.first.phase.map((phase,k)=>angleDistance(phase-pair.second.phase[k])));
        }
        const error=Math.max(...phaseErrors),score=Math.min(...amplitudes),coherence=Math.max(...coherences);
        const strong=phaseErrors.filter((value,i)=>value<.75&&amplitudes[i]>.7).length;
        const robustScore=amplitudes.slice().sort((a,b)=>a-b)[2];
        let localSpectralSupport=null;
        // A photographed colour channel can attenuate the guide, while a
        // single source-photo frequency can obscure one of its eight tones.
        // The remaining fixed-phase tones have to rise above neighbouring
        // frequencies. An absolute RGB threshold alone is not safe.
        const photographed=()=> {
          if(phaseErrors.filter((value,i)=>value<.75&&amplitudes[i]>.3).length<6||robustScore<.4||
            phaseErrors.filter((value,i)=>value>1.2&&amplitudes[i]>.3).length>1||coherences.filter(value=>value<.6).length<3)return 0;
          const noise=[...stripNoise(q,scale,false,measured[0].first,sx,ex),...stripNoise(q,scale,false,measured[0].second,sx,ex),
            ...stripNoise(q,scale,true,measured[1].first,sy,ey),...stripNoise(q,scale,true,measured[1].second,sy,ey)];
          const supported=phaseErrors.filter((value,i)=>value<.75&&amplitudes[i]>.3&&amplitudes[i]/noise[i]>=1.3).length;
          return supported>=6?supported:0;
        };
        if(q.knownBounds) {
          const original=strong>=6&&robustScore>=.8&&!phaseErrors.some((value,i)=>value>1.2&&amplitudes[i]>.3)&&
            coherences.filter(value=>value<.6).length>=3&&coherence<=1.2;
          if(!original) {
            localSpectralSupport=photographed();
            if(!localSpectralSupport)continue;
          }
        } else if(error>.75||coherence>.4||score<1.05) {
          // Chrome around a picture dilutes the amplitude below the full-bleed
          // gate even when all eight tones still have the guide's phase.
          if(error>.75||coherence>.4)continue;
          localSpectralSupport=photographed();
          if(!localSpectralSupport)continue;
        }
        const confidence=q.knownBounds?robustScore:score;
        if(!best||confidence>best.score)best={scale,turn,score:confidence,pairs:measured,phaseError:error,localSpectralSupport,
          phaseSupport:phaseErrors.filter((error,i)=>error<.75&&amplitudes[i]>.3).length,
          outlierComponents:phaseErrors.filter((error,i)=>error>1.2&&amplitudes[i]>.3).length};
      }
    }
    return best;
  }
  function axisStorage(q) {
    const axis=(N,M)=>({basis:new Float64Array(N*4),rs:new Float64Array(M*4),prefix:new Float32Array(M*(N+1)*4)});
    q.axes=[axis(q.w,q.h),axis(q.h,q.w)];return q;
  }
  function hasFlatBorder(pixels,width,height) {
    const colours=[];
    for(let i=0;i<12;i++)for(const [x,y] of [[i*(width-1)/11,0],[i*(width-1)/11,height-1],[0,i*(height-1)/11],[width-1,i*(height-1)/11]]) {
      const at=(Math.round(x)+Math.round(y)*width)*4;colours.push([pixels[at],pixels[at+1],pixels[at+2]]);
    }
    return colours.some(seed=>colours.filter(value=>Math.max(...value.map((v,i)=>Math.abs(v-seed[i])))<20).length>=24);
  }
  // Geometry proposals only: browser chrome and a bezel can hide the picture
  // inside the outer screen outline. Frequency/phase verification is unchanged.
  function contentQuads(pixels,w,h,check) {
    const rgb=(x,y,k)=>pixels[(x+y*w)*4+k];
    const peaks=(vertical,start,stop)=>{
      const n=vertical?w:h,m=vertical?h:w,values=[];
      for(let p=1;p<n;p++) {
        if((p&31)===0)check();
        let score=0;
        for(let q=start;q<stop;q++)for(let k=0;k<3;k++)
          score+=Math.abs(vertical?rgb(p,q,k)-rgb(p-1,q,k):rgb(q,p,k)-rgb(q,p-1,k));
        values.push({p,score:score/Math.max(1,stop-start)});
      }
      values.sort((a,b)=>b.score-a.score);const found=[];
      for(const value of values)if(!found.some(other=>Math.abs(other.p-value.p)<Math.max(3,n*.02))) {
        found.push(value);if(found.length===8)break;
      }
      return found;
    };
    const rows=[{p:0,score:0},...peaks(false,0,w),{p:h-1,score:0}],pairs=[];
    for(const a of rows)for(const b of rows)if(b.p-a.p>=h*.5)
      pairs.push({top:a.p,bottom:b.p,score:a.score+b.score});
    pairs.sort((a,b)=>b.score-a.score);
    return pairs.slice(0,6).map(pair=>{
      const columns=peaks(true,pair.top,pair.bottom);
      const left=columns.find(value=>value.p<w*.25)?.p||0;
      const right=columns.find(value=>value.p>w*.75)?.p||w-1;
      return [{x:left,y:pair.top},{x:right,y:pair.top},{x:right,y:pair.bottom},{x:left,y:pair.bottom}];
    });
  }
  function quadMap(corners) {
    const [a,b,c,d]=corners,dx1=b.x-c.x,dx2=d.x-c.x,dx3=a.x-b.x+c.x-d.x;
    const dy1=b.y-c.y,dy2=d.y-c.y,dy3=a.y-b.y+c.y-d.y,denominator=dx1*dy2-dx2*dy1;
    if(Math.abs(denominator)<1e-8)return null;
    const g=(dx3*dy2-dx2*dy3)/denominator,h=(dx1*dy3-dx3*dy1)/denominator;
    const H=[b.x-a.x+g*b.x,d.x-a.x+h*d.x,a.x,b.y-a.y+g*b.y,d.y-a.y+h*d.y,a.y,g,h];
    return (x,y)=>{const z=g*x+h*y+1;return{x:(H[0]*x+H[1]*y+H[2])/z,y:(H[3]*x+H[4]*y+H[5])/z};};
  }
  function rectify(q,quad,check) {
    const start=quad.reduce((best,p,i)=>p.x+p.y<quad[best].x+quad[best].y?i:best,0);
    quad=quad.slice(start).concat(quad.slice(0,start));
    const length=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),r=q.reduction;
    const w=Math.round((length(quad[0],quad[1])+length(quad[3],quad[2]))/(2*r));
    const h=Math.round((length(quad[0],quad[3])+length(quad[1],quad[2]))/(2*r));
    const map=quadMap(quad);
    if(!map||w<64||h<48||w*h>q.w*q.h*1.2)return null;
    const data=new Float64Array(w*h),offset=(r-1)/2;
    for(let y=0;y<h;y++) {
      if((y&31)===0)check();
      for(let x=0;x<w;x++) {
        const p=map((x+.5)/w,(y+.5)/h),sx=Math.max(0,Math.min(q.w-1,(p.x-offset)/r)),sy=Math.max(0,Math.min(q.h-1,(p.y-offset)/r));
        const ix=Math.floor(sx),iy=Math.floor(sy),jx=Math.min(q.w-1,ix+1),jy=Math.min(q.h-1,iy+1),fx=sx-ix,fy=sy-iy;
        data[x+y*w]=(q.data[ix+iy*q.w]*(1-fx)+q.data[jx+iy*q.w]*fx)*(1-fy)+(q.data[ix+jy*q.w]*(1-fx)+q.data[jx+jy*q.w]*fx)*fy;
      }
    }
    return axisStorage({data,w,h,reduction:r,map,quad,knownBounds:true,diagnostic:q.diagnostic});
  }
  function orthogonalQuads(quads) {
    const groups=[];
    for(const quad of quads)for(let i=0;i<4;i++) {
      const a=quad[i],b=quad[(i+1)%4];let angle=Math.atan2(b.y-a.y,b.x-a.x);
      angle=Math.atan2(Math.sin(4*angle),Math.cos(4*angle))/4;
      let group=groups.find(group=>angleDistance(group.angle-angle)<.004);
      if(!group){group={angle,values:[]};groups.push(group);}group.values.push(angle);
      group.angle=group.values.reduce((sum,value)=>sum+value,0)/group.values.length;
    }
    const points=quads.flat();
    return groups.sort((a,b)=>b.values.length-a.values.length).slice(0,3).map(group=> {
      const cs=Math.cos(group.angle),sn=Math.sin(group.angle),xs=points.map(p=>cs*p.x+sn*p.y),ys=points.map(p=>-sn*p.x+cs*p.y);
      const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
      return [[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y])=>({x:cs*x-sn*y,y:sn*x+cs*y}));
    });
  }
  async function searchQuarter(q,options,check) {
    let best=null,lastYield=Date.now();
    const low=options.minimumScale||.5,high=options.maximumScale||2.5,step=options.scaleStep||.01;
    try {
    for(let scale=low;scale<=high+step/2;scale+=step) {
      if(q.diagnostic)q.diagnostic.scales++;
      check();const candidate=matchFrame(q,scale,check);
      if(candidate&&(!best||candidate.score>best.score))best=candidate;
      // A phase-locked scale is already within one step of the guide. Check the
      // neighbouring step, then stop, so later false peaks do not use the budget.
      if(best?.phaseSupport>=6&&best.phaseError<=.75&&scale>best.scale+step)return best;
      if(Date.now()-lastYield>40){await pause();lastYield=Date.now();}
    }
    } catch(error) {
      // A completed phase-verified match stays valid when later scales exhaust
      // the budget. Cancellation still discards the frame; partial fits do not count.
      if(error.name!=='EdgeGuideLimit'||!best)throw error;
    }
    return best;
  }
  async function detect(pixels,width,height,options={}) {
    if(width<192||height<128||pixels.length!==width*height*4)return null;
    const started=Date.now(),deadline=Math.min(options.deadline||Infinity,started+(options.maxMilliseconds||1000));
    const diagnostic=options.diagnostic?{strongest:null,scales:0}:null;
    const snapshot=status=>diagnostic?{...diagnostic,status,width,height,milliseconds:Date.now()-started}:undefined;
    const miss=status=>diagnostic?.strongest?{detected:false,diagnostic:snapshot(status)}:null;
    const check=()=> {
      if(options.signal?.aborted){const error=new Error('Search cancelled.');error.name='AbortError';throw error;}
      if(Date.now()>=deadline){const error=new Error('Edge-guide appraisal time limit.');error.name='EdgeGuideLimit';throw error;}
    };
    try {
      const longest=Math.max(width,height);
      const reduction=options.reduction||(longest>3600?12:longest>2400?8:4);
      if(!Number.isInteger(reduction)||reduction<1||reduction>12)return null;
      const searchOptions={...options,minimumScale:options.minimumScale??.5*reduction/4,
        maximumScale:options.maximumScale??2.5*reduction/4,scaleStep:options.scaleStep??.01*reduction/4};
      // This is the only image reduction. Full-resolution pixel positions map
      // directly to this explicitly chosen sampling grid.
      const w=Math.floor(width/reduction),h=Math.floor(height/reduction),data=new Float64Array(w*h),coarse=new Uint8Array(w*h*4);
      for(let y=0;y<h;y++) {
        if((y&63)===0){check();if(y===0)await pause();}
        for(let x=0;x<w;x++) {
          let red=0,green=0,blue=0;
          for(let dy=0;dy<reduction;dy++)for(let dx=0;dx<reduction;dx++) {
            const i=(x*reduction+dx+(y*reduction+dy)*width)*4;
            red+=pixels[i];green+=pixels[i+1];blue+=pixels[i+2];
          }
          const area=reduction*reduction,i=(x+y*w)*4;
          data[x+y*w]=((red+blue)*.5-green)/area;
          coarse[i]=Math.round(red/area);coarse[i+1]=Math.round(green/area);coarse[i+2]=Math.round(blue/area);coarse[i+3]=255;
        }
      }
      const original=axisStorage({data,w,h,reduction,diagnostic});let selected=original,best=null;
      // A picture inside a monitor does not sit on the camera-frame inset.
      // Outline, full-bleed and content proposals must leave time for that search.
      const reserve=Math.max(0,(deadline-started)*.4);
      const preliminary=()=> {
        check();
        if(Date.now()+reserve>=deadline){const error=new Error('Keeping time for the framed guide search.');error.name='EdgeGuideLimit';throw error;}
      };
      const continueStage=error=> {
        if(error.name==='AbortError'||error.name!=='EdgeGuideLimit'||Date.now()>=deadline)throw error;
      };
      if(options.outlineSearch!==false&&root.PixelStowTransform?.proposeOutlines&&hasFlatBorder(pixels,width,height)) {
        let quads=[];
        // Propose the outline on the very same coarse raster. Re-scanning the
        // full camera image here could exhaust the deadline before calibration.
        // A quarter of the live one-second budget was 250ms, which expired
        // before a photographed screen's bezel could be returned. Share the
        // appraisal deadline instead, and keep the file cap at 1.5 seconds.
        const outlineBudget=Math.min(1500,Math.max(0,deadline-reserve-Date.now()));
        try {quads=(await root.PixelStowTransform.proposeOutlines(coarse,w,h,{signal:options.signal,maxMilliseconds:outlineBudget,deadline:Math.min(deadline-reserve,Date.now()+outlineBudget)}))
          .map(quad=>quad.map(p=>({x:(p.x+.5)*reduction-.5,y:(p.y+.5)*reduction-.5})));}
        catch(error){if(error.name==='AbortError')throw error;}
        // Keep shared rectangular edges first: small independent line-fit
        // errors can bias the scale enough to spoil the single marker grid.
        try {for(const quad of orthogonalQuads(quads).concat(quads)) {
          if(polygonArea(quad)/(width*height)<(options.minimumCoverage??.5))continue;
          const rectified=rectify(original,quad,preliminary);if(!rectified)continue;
          const candidate=await searchQuarter(rectified,searchOptions,preliminary);
          if(candidate){best=candidate;selected=rectified;break;}
        }}catch(error){continueStage(error);}
      }
      if(!best){
        original.knownBounds=true;
        try {best=await searchQuarter(original,searchOptions,preliminary);}
        catch(error){continueStage(error);}
        original.knownBounds=false;
      }
      if(!best&&options.contentSearch!==false) {
        // Give inner-picture proposals a bounded turn before integrating over
        // all the surrounding clutter. Keep time for the original global search.
        const contentDeadline=Math.min(deadline-reserve,Date.now()+Math.min(800,(deadline-Date.now())*.4));
        const contentCheck=()=>{preliminary();if(Date.now()>=contentDeadline){const error=new Error('Content proposal budget');error.name='EdgeGuideLimit';throw error;}};
        try {for(const quad of contentQuads(coarse,w,h,contentCheck)) {
          const full=quad.map(p=>({x:(p.x+.5)*reduction-.5,y:(p.y+.5)*reduction-.5}));
          if(polygonArea(full)/(width*height)<(options.minimumCoverage??.5))continue;
          const rectified=rectify(original,full,contentCheck);if(!rectified)continue;
          const candidate=await searchQuarter(rectified,searchOptions,contentCheck);
          if(candidate){best=candidate;selected=rectified;break;}
        }}catch(error){continueStage(error);}
      }
      if(!best)best=await searchQuarter(original,searchOptions,check);
      if(!best)return miss('no-match');
      const horizontal=best.pairs[0],vertical=best.pairs[1];
      const bounds={left:vertical.first.position*reduction-INSET*best.scale,
        top:horizontal.first.position*reduction-INSET*best.scale,
        right:vertical.second.position*reduction+(INSET+BAND)*best.scale,
        bottom:horizontal.second.position*reduction+(INSET+BAND)*best.scale};
      let corners=[{x:bounds.left,y:bounds.top},{x:bounds.right-best.scale,y:bounds.top},
        {x:bounds.right-best.scale,y:bounds.bottom-best.scale},{x:bounds.left,y:bounds.bottom-best.scale}];
      corners=corners.slice(best.turn).concat(corners.slice(0,best.turn));
      if(selected.map) {
        corners=corners.map(point=>selected.map((point.x+.5)/(selected.w*reduction),(point.y+.5)/(selected.h*reduction)));
      }
      const orientation=Math.atan2(corners[1].y-corners[0].y,corners[1].x-corners[0].x);
      const coverage=polygonArea(corners)/(width*height);
      if(coverage<(options.minimumCoverage??.5))return miss('coverage-too-small');
      if(diagnostic) {
        // The strongest raw response can be a rejected toolbar or source-photo
        // feature at a different scale. Show the four strips actually accepted.
        const r=selected.reduction,L=Math.round(BAND*best.scale/r);
        const spans=[[vertical.first.position+(64-INSET)*best.scale/r,vertical.second.position+(INSET+BAND-64)*best.scale/r],
          [horizontal.first.position+(64-INSET)*best.scale/r,horizontal.second.position+(INSET+BAND-64)*best.scale/r]];
        diagnostic.accepted=best.pairs.flatMap((pair,axis)=>[pair.first,pair.second].map(strip=>{
          const [start,stop]=spans[axis],y=strip.position;
          const points=axis?[[y,start],[y+L,start],[y+L,stop],[y,stop]]:[[start,y],[stop,y],[stop,y+L],[start,y+L]];
          return {axis:axis?'vertical':'horizontal',scale:best.scale,score:strip.score,
            band:points.map(([x,y])=>selected.map?selected.map(x/selected.w,y/selected.h):{x:x*r-.5,y:y*r-.5})};
        }));
      }
      return {detected:true,confirmed:false,experimental:true,kind:'opponent-edge-guide',width,height,reduction,
        ...(diagnostic?{diagnostic:snapshot('matched')}:{}),
        scale:best.scale,fx:Math.cos(orientation)/(128*best.scale),fy:Math.sin(orientation)/(128*best.scale),orientation,score:best.score,agreement:true,
        contrast:best.score,support:4,coverage,localSpectralSupport:best.localSpectralSupport,phaseSupport:best.phaseSupport,outlierComponents:best.outlierComponents,
        ...(selected.map?{rectifiedBounds:bounds}:{bounds}),corners,outlined:Boolean(selected.map),workingWidth:w,workingHeight:h,milliseconds:Date.now()-started,
        evidence:best.pairs.map(pair=>({coherence:pair.coherence,closure:[pair.first.closure,pair.second.closure],
          positions:[pair.first.position*reduction,pair.second.position*reduction]}))};
    } catch(error){if(error.name==='EdgeGuideLimit')return miss('time-limit');throw error;}
  }
  root.PixelStowEdgeGuide={apply,detect,profile:Object.freeze({experimental:true,amplitude:LIMIT,band:BAND,inset:INSET,normalPitch:NORMAL,pitches:Object.freeze(PITCHES.slice())})};
})(typeof window!=='undefined'?window:self);
