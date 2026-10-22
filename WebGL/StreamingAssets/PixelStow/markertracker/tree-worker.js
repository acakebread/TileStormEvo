// Frequency evidence orders a bounded spatial search; it cannot prove that a
// large region is empty. Stop at the first header and return it to Previous
// BSP's guided resolver, which finishes this same retained camera raster.
importScripts('../pixelstow-spectrum.js?v=20261018-capture1','../pixelstow-transform.js?v=20261019-v6-native1','../pixelstow.js?v=20261021-native-detail1','./geometry.js?v=20261018-guided1','./search-plan.js?v=20261018-wavelength1','./search-gpu.js?v=20261019-gpu-output1');
const ids=[0,2,6,8],point=MarkerTrackerGeometry.point;
const levels=new Map(),scratch=typeof OffscreenCanvas==='function'?new OffscreenCanvas(1,1):null;
const ctx=scratch?.getContext('2d',{willReadFrequently:true});
let gpu=null;
const tileLimit=512;
function children(r,split){
  // Discovery runs only without a current header. A bounded native tile can
  // check all resolvable wavelengths; known markers never enter this tree.
  const stopX=256,stopY=256;
  let splitX=r.w>stopX,splitY=r.h>stopY;
  if(split==='halves'&&splitX&&splitY){
    if(r.w/stopX>=r.h/stopY)splitY=false;else splitX=false;
  }
  const xs=splitX?[r.x,r.x+r.w/2,r.x+r.w]:[r.x,r.x+r.w];
  const ys=splitY?[r.y,r.y+r.h/2,r.y+r.h]:[r.y,r.y+r.h];
  if(xs.length===2&&ys.length===2)return [];
  const out=[];
  for(let y=0;y<ys.length-1;y++)for(let x=0;x<xs.length-1;x++)out.push({x:xs[x],y:ys[y],w:xs[x+1]-xs[x],h:ys[y+1]-ys[y],depth:r.depth+1});
  return out;
}
function pyramid(n){
  if(levels.has(n))return levels.get(n);
  const source=pyramid(n/2),canvas=new OffscreenCanvas(Math.max(1,Math.round(source.width/2)),Math.max(1,Math.round(source.height/2)));
  const c=canvas.getContext('2d',{alpha:false});c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.drawImage(source,0,0,canvas.width,canvas.height);
  levels.set(n,canvas);return canvas;
}
function sampleBounds(node,width,height,nominal){
  // Core partitions own possible marker centres. Their input images overlap by
  // a verified patch size, or the full resolvable footprint at this MIP. The
  // latter is half of 49*(2.4+2.4), plus phase context, in sample pixels. It
  // does not inherit a false FFT's footprint or cut patches at a core boundary.
  const hint=node.hint,phase=2*nominal;
  const padX=Math.max(node.w*.18,hint?(hint.supportX||hint.spanX)*.9+phase:120*nominal);
  const padY=Math.max(node.h*.18,hint?(hint.supportY||hint.spanY)*.9+phase:120*nominal);
  const pixelsPolygons=node.polygons?MarkerTrackerSearchPlan.contextRegions(node.polygons,padX,padY,width,height):null;
  const limit=pixelsPolygons?MarkerTrackerSearchPlan.regionBounds(pixelsPolygons):{x:0,y:0,right:width,bottom:height};
  const levelWidth=Math.ceil(width/nominal),levelHeight=Math.ceil(height/nominal),rx=width/levelWidth,ry=height/levelHeight;
  const x=Math.max(0,Math.floor(Math.max(node.x-padX,limit.x)/rx)),y=Math.max(0,Math.floor(Math.max(node.y-padY,limit.y)/ry));
  const right=Math.min(levelWidth,Math.ceil(Math.min(node.x+node.w+padX,limit.right)/rx)),bottom=Math.min(levelHeight,Math.ceil(Math.min(node.y+node.h+padY,limit.bottom)/ry));
  const w=right-x,h=bottom-y;
  return {x,y,w,h,rx,ry,padX,padY,pixelsPolygons};
}
function box2(pixels,width,height){
  // Match Previous BSP's final 2x2 average; a smoothed final canvas shrink can
  // suppress the carrier. Only a bounded tile is read back at twice its size.
  const w=Math.ceil(width/2),h=Math.ceil(height/2),out=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const right=Math.min(width,x*2+2),bottom=Math.min(height,y*2+2),at=(x+y*w)*4;
    let r=0,g=0,b=0,count=0;
    for(let sy=y*2;sy<bottom;sy++)for(let sx=x*2;sx<right;sx++){
      const p=(sx+sy*width)*4;r+=pixels[p];g+=pixels[p+1];b+=pixels[p+2];count++;
    }
    out[at]=Math.round(r/count);out[at+1]=Math.round(g/count);out[at+2]=Math.round(b/count);
    out[at+3]=255;
  }
  return {pixels:out,width:w,height:h};
}
function sample(node,width,height,known,nominal,bounds=sampleBounds(node,width,height,nominal)){
  const {rx,ry,padX,padY,pixelsPolygons}=bounds,factor=nominal===1?1:2,level=pyramid(nominal/factor);
  const x=bounds.x*factor,y=bounds.y*factor,w=Math.min(level.width-x,bounds.w*factor),h=Math.min(level.height-y,bounds.h*factor);
  const inputX=width/level.width,inputY=height/level.height;
  scratch.width=w;scratch.height=h;
  ctx.fillStyle='#808080';ctx.fillRect(0,0,w,h);ctx.save();
  if(pixelsPolygons){
    ctx.beginPath();
    for(const poly of pixelsPolygons){
      poly.forEach((p,i)=>i?ctx.lineTo((p.x+.5)/inputX-.5-x,(p.y+.5)/inputY-.5-y):ctx.moveTo((p.x+.5)/inputX-.5-x,(p.y+.5)/inputY-.5-y));ctx.closePath();
    }
    ctx.clip();
  }
  ctx.drawImage(level,x,y,w,h,0,0,w,h);ctx.restore();
  // Do not let a previously verified patch monopolize a node's strongest peak.
  for(const m of known){
    const corners=[[0,0],[m.patchWidth-1,0],[m.patchWidth-1,m.patchHeight-1],[0,m.patchHeight-1]].map(([u,v])=>point(m.matrix,u,v));
    ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo((p.x+.5)/inputX-.5-x,(p.y+.5)/inputY-.5-y):ctx.moveTo((p.x+.5)/inputX-.5-x,(p.y+.5)/inputY-.5-y));
    ctx.closePath();ctx.fillStyle='#808080';ctx.fill();
  }
  const pixels=new Uint8Array(ctx.getImageData(0,0,w,h).data.buffer);
  const core={x:node.x,y:node.y,w:node.w,h:node.h};
  if(node.polygons)core.polygons=MarkerTrackerSearchPlan.clipRegions(node.polygons,core);
  const region={x:bounds.x*rx,y:bounds.y*ry,w:bounds.w*rx,h:bounds.h*ry,core,padX,padY};
  if(pixelsPolygons)region.polygons=MarkerTrackerSearchPlan.clipRegions(pixelsPolygons,region);
  const reduced=factor===2?box2(pixels,w,h):{pixels,width:w,height:h};
  return {...reduced,nominal,region};
}
function lift(m,tile){
  const r=tile.region,sx=r.w/tile.width,sy=r.h/tile.height;
  const matrix=MarkerTrackerGeometry.multiply([sx,0,r.x+(sx-1)/2,0,sy,r.y+(sy-1)/2,0,0,1],m.matrix);
  return {...m,mip:tile.nominal,matrix};
}
function pitchDifference(a,b){
  const lengths=c=>[Math.hypot(c[0],c[1]),Math.hypot(c[2],c[3])].sort((u,v)=>u-v),u=lengths(a),v=lengths(b);
  return Math.max(...u.map((n,i)=>Math.abs(Math.log2(n/v[i]))));
}
function bandHint(basis){
  const spanX=Math.max(24,49*(Math.abs(basis[0])+Math.abs(basis[2]))),spanY=Math.max(24,49*(Math.abs(basis[1])+Math.abs(basis[3])));
  const pitch=Math.sqrt(Math.hypot(basis[0],basis[1])*Math.hypot(basis[2],basis[3]));
  return {basis,spanX,spanY,pitch,nominal:2**Math.max(0,Math.round(Math.log2(pitch)))};
}
self.onmessage=async({data})=>{
  let compute=null;
  const backendStats=()=>({...(compute?.stats||{backend:data.hardwareSearch?'GPU requested · direct CPU headers':'CPU',gpuFfts:0,gpuPilots:0}),
    workerMilliseconds:performance.now()-started,cpuFfts:stats.ffts-(compute?.stats.gpuFfts||0),cpuPilots:stats.pilotMaps-(compute?.stats.gpuPilots||0)});
  const started=performance.now();let lastProgress=started;
  const stats={nodes:0,rejected:0,expanded:0,leaves:0,resamples:0,ffts:0,pilotMaps:0,reads:0,earlyReads:0,bands:0,wavelengthCulls:0,reductionCulls:0,deferred:0,missSplits:0,
    poseReads:0,poseChecks:0,poseHits:0,seedFfts:null,afterSeedFfts:0,skipped:0,preEliminated:0,bypassed:0,scales:{},rootScales:[],
    firstMs:null,milliseconds:0,complete:false,maxTile:0,split:data.split||'quarters'};
  const searchCompute={
    spectrum(...args){return compute?.spectrum(...args)??null;},
    candidates(...args){stats.pilotMaps++;return compute?.candidates(...args)??null;}
  };
  const known=[],trace=[];
  const fruitlessLimit=data.fruitlessMilliseconds>0?data.fruitlessMilliseconds:0;
  const outOfTime=()=>fruitlessLimit>0&&!known.length&&performance.now()-started>=fruitlessLimit;
  const planner=MarkerTrackerSearchPlan;
  let replan=false;
  const progress=(rect,marker,force=false)=>{
    // Live consumers need verified markers and progress even when debug node
    // outlines/traces are hidden. Debug visibility must not disable tracking.
    if(!data.debugSearch&&!data.liveFeedback)return;
    stats.milliseconds=performance.now()-started;
    stats.afterSeedFfts=stats.seedFfts===null?0:stats.ffts-stats.seedFfts;
    if(force||marker||performance.now()-lastProgress>=40){
      self.postMessage({id:data.id,progress:true,rect,marker,stats:{...stats,...backendStats(),scales:{...stats.scales}},trace:trace.splice(0)});lastProgress=performance.now();
    }
  };
  try{
    if(!ctx||!data.bitmap){data.bitmap?.close();self.postMessage({id:data.id,result:{unsupported:true}});return;}
    const width=data.bitmap.width,height=data.bitmap.height;
    const rootNominal=2**Math.max(0,Math.ceil(Math.log2(Math.max(width,height)/512)));stats.rootNominal=rootNominal;
    const maximumReduction=2**Math.max(0,Math.floor(Math.log2(Math.min(width,height)/(49*.45))));
    const remembered=data.scalePrior?planner.footprint(data.scalePrior):null;
    stats.rememberedScale=Boolean(remembered&&!known.length);
    levels.clear();const native=new OffscreenCanvas(width,height);native.getContext('2d',{alpha:false}).drawImage(data.bitmap,0,0);data.bitmap.close();levels.set(1,native);
    function reductions(node){
      const values=[];
      for(let n=1;n<=maximumReduction;n*=2)values.push(n);
      const preferred=node.hint?.nominal||node.preferred||remembered?.nominal||2**Math.max(0,Math.ceil(Math.log2(Math.max(node.w,node.h)/tileLimit)));
      return values.sort((a,b)=>Math.abs(Math.log2(a/preferred))-Math.abs(Math.log2(b/preferred))||a-b);
    }
    function accept(marker,tile){
      const found=lift(marker,tile),same=known[0];
      if(!ids.includes(found.id)||found.verification!=='header'||known.some(m=>m.id===found.id))return false;
      if(same&&(same.originalWidth!==found.originalWidth||same.originalHeight!==found.originalHeight||same.carrierVersion!==found.carrierVersion))return false;
      known.push(found);stats.anchors=known.length;stats.directional=true;
      stats.targetIds=ids.filter(id=>!known.some(m=>m.id===id));
      if(stats.firstMs===null)stats.firstMs=performance.now()-started;
      if(stats.seedFfts===null)stats.seedFfts=stats.ffts;
      replan=true;
      if(known.length===4){stats.targetRegions=[];stats.activeIds=[];}
      progress(tile.region,found);
      return true;
    }
    function directPose(target){
      const proposal=target.proposal;if(!proposal)return false;
      const centre=point(proposal.matrix,(proposal.patchWidth-1)/2,(proposal.patchHeight-1)/2);
      if(centre.x<0||centre.y<0||centre.x>=width||centre.y>=height)return false;
      const corners=proposal.corners,left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));
      const node={x:left,y:top,w:Math.max(...corners.map(p=>p.x))-left,h:Math.max(...corners.map(p=>p.y))-top,depth:1,
        hint:target.hint,limit:target.bounds,polygons:[target.polygon]};
      const tile=sample(node,width,height,known,target.hint.nominal),r=tile.region,sx=r.w/tile.width,sy=r.h/tile.height;
      const seed=MarkerTrackerGeometry.multiply([1/sx,0,(.5-r.x)/sx-.5,0,1/sy,(.5-r.y)/sy-.5,0,0,1],proposal.matrix);
      stats.poseReads++;
      stats.scales[tile.nominal]=(stats.scales[tile.nominal]||0)+1;stats.activeIds=[target.id];progress(r,undefined,true);
      // Same direct header/phase checks as Previous BSP's guided operation.
      // There is no FFT, tree descent or guessed acceptance on this path.
      const offsets=[0,-.5,.5,-1,1,-2,2];
      for(const dy of offsets)for(const dx of offsets){
        const matrix=seed.map((v,i)=>i<3?v+dx*seed[i+6]:i<6?v+dy*seed[i+3]:v);
        stats.poseChecks++;
        const marker=PixelStow.readVisualMarker(tile.pixels,tile.width,tile.height,{...proposal,matrix});
        if(marker){
          stats.poseHits++;
          if(accept(marker,tile))return true;
          stats.poseHits--;
        }
      }
      return false;
    }
    async function inspect(original){
      stats.nodes++;stats.depth=Math.max(stats.depth||0,original.depth);
      if(outOfTime()){stats.abandoned=true;return {node:original,candidates:[],descendants:[],quality:0,score:0,region:null};}
      const node=original;
      const info={node,candidates:[],descendants:children(node,stats.split),quality:0,score:0,region:null};
      stats.activeIds=node.allowedIds||ids.filter(id=>!known.some(m=>m.id===id));
      // Check all readable wavelengths before descending. Finer resolutions
      // that exceed the header reader's tile bound belong to smaller children;
      // do not compute a large FFT whose result cannot be read here.
      for(const nominal of reductions(node)){
        if(replan||outOfTime()){if(outOfTime())stats.abandoned=true;return info;}
        const bounds=sampleBounds(node,width,height,nominal);
        if(Math.max(bounds.w,bounds.h)>tileLimit){stats.deferred++;continue;}
        if(Math.min(bounds.w,bounds.h)<16){stats.skipped++;continue;}
        if(node.depth===0&&!stats.rootScales.includes(nominal))stats.rootScales.push(nominal);
        const tile=sample(node,width,height,known,nominal,bounds);info.region=tile.region;
        stats.maxTile=Math.max(stats.maxTile,tile.width,tile.height);
        stats.scales[nominal]=(stats.scales[nominal]||0)+1;progress(tile.region);
        const luma=new Float32Array(tile.width*tile.height);let sum=0,sum2=0;
        for(let i=0;i<luma.length;i++){const v=(tile.pixels[i*4]+tile.pixels[i*4+1]+tile.pixels[i*4+2])/3;luma[i]=v;sum+=v;sum2+=v*v;}
        if(Math.min(tile.width,tile.height)<16||sum2/luma.length-(sum/luma.length)**2<=1){stats.skipped++;continue;}
        const sx=tile.region.w/tile.width,sy=tile.region.h/tile.height;
        stats.ffts++;
        const signature=await PixelStowSpectrum.analyze(luma,tile.width,tile.height,{
          fast:true,continuousWorker:true,searchCompute,markerRatios:[4/5],maxFamilies:3,maxPeaks:12,check(){}
        });
        stats.wavelengthCulls+=signature.scaleRejected;
        const candidates=[];
        for(const family of signature.families){
          const b=family.basis,basis=[b[0]*sx,b[1]*sy,b[2]*sx,b[3]*sy];
          const hint=bandHint(basis);
          // This wavelength cannot describe a complete patch in these pixels.
          if(hint.spanX>tile.region.w*1.05||hint.spanY>tile.region.h*1.05){stats.wavelengthCulls++;continue;}
          const reducedPitch=Math.sqrt(Math.hypot(b[0],b[1])*Math.hypot(b[2],b[3]));
          // Lost tracks leave a soft size prior, not stale position constraints.
          // A current CRC header will end this discovery job entirely.
          const prior=remembered&&!known.length?2**(-2*pitchDifference(basis,remembered.basis)):1;
          const score=Math.log1p(family.score)*Math.exp(-Math.abs(Math.log2(reducedPitch)));
          const candidate={tile,signature,family,basis,hint,score,priority:score*prior};
          candidates.push(candidate);
        }
        candidates.sort((a,b)=>b.priority-a.priority);
        info.candidates.push(...candidates);stats.bands+=candidates.length;
        if(data.debugSearch)trace.push({x:node.x,y:node.y,w:node.w,h:node.h,depth:node.depth,nominal,likely:signature.likely});progress(tile.region);
        // A verified header ends the speculative walk immediately, just as in
        // Previous BSP. Do not finish every other MIP before trying to read it.
        await readNode(info,candidates);if(replan)return info;
      }
      info.candidates.sort((a,b)=>b.priority-a.priority);
      if(info.candidates.length){
        info.score=info.candidates[0].priority;
        info.preferred=info.candidates[0].hint.nominal;
      }else info.preferred=node.preferred;
      return info;
    }
    async function readNode(info,candidates){
      if(replan||!candidates.length||outOfTime()){if(outOfTime())stats.abandoned=true;return;}
      const tile=candidates[0].tile;
      const budget=!known.length&&fruitlessLimit?Math.max(1,fruitlessLimit-(performance.now()-started)):5000;
      // Give the strongest family its four rotations and full eight-peak
      // refinement first, matching Previous BSP. Alternate families share the
      // remainder of the same bounded tile budget instead of delaying it.
      const deadline=Date.now()+Math.min(5000,budget),rounds=[[candidates[0]],candidates.slice(1)].filter(r=>r.length);
      for(const round of rounds){
        if(Date.now()>=deadline)break;
        const bases=round.flatMap(c=>c.family.bases),signature={...round[0].signature,bases,likely:true};
        stats.reads++;if(info.descendants.length)stats.earlyReads++;
        progress(tile.region,undefined,true);
        try{
          const found=await PixelStow.findVisualTransform(tile.pixels,tile.width,tile.height,{
            deadline,maxMilliseconds:Math.min(5000,budget),worker:false,geometryOnly:true,fast:true,continuousWorker:true,searchCompute,
            singleResolution:true,scaleGuide:false,seedOnly:true,frequencyOnly:true,frequencySignature:signature,
            frequencyBankLimit:bases.length,seedRefinements:8,
            forceSearch:false,mode:'perspective',edgeBand:.5,camera:true,carrierVersion:known[0]?.carrierVersion
          });
          info.quality=Math.max(info.quality,found?.evidence?.pilotQuality||0);
          const marker=found?.markers?.find(m=>ids.includes(m.id)&&m.verification==='header'&&!known.some(k=>k.id===m.id)&&(!info.node.allowedIds||info.node.allowedIds.includes(m.id)));
          if(marker&&accept(marker,tile))return;
        }catch(error){if(error?.name!=='SearchLimit')throw error;}
      }
    }
    async function traverse(){
      stats.entryDepth=0;stats.seedNodes=1;
      progress(null,undefined,true);
      let frontier=[{x:0,y:0,w:width,h:height,depth:0}];
      while(frontier.length&&!replan&&known.length<4){
        if(outOfTime()){stats.abandoned=true;break;}
        const next=[];
        // Evidence orders neighbours at a depth; a false peak cannot take the
        // worker all the way down one branch ahead of the rest of the image.
        frontier.sort((a,b)=>a.depth-b.depth||(b.priority||0)-(a.priority||0));
        for(const node of frontier){
          const info=await inspect(node);if(stats.abandoned||outOfTime()){stats.abandoned=true;return;}if(replan)return;
          if(!info.descendants.length){
            stats.leaves++;if(!info.candidates.length)stats.rejected++;
            progress(info.region);continue;
          }
          stats.expanded++;if(!info.candidates.length)stats.missSplits++;
          for(const child of info.descendants){
            next.push({...child,preferred:info.preferred,priority:info.quality*100+info.score});
          }
        }
        frontier=next;
      }
    }
    // Re-read tracked identities in THIS captured raster. A live template pose
    // alone is never counted among this buffer's four acquired headers.
    const framePolygon=[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}];
    stats.anchorChecks=0;stats.anchorHits=0;
    for(const anchor of data.anchors||[]){
      stats.anchorChecks++;
      const corners=[[0,0],[anchor.patchWidth-1,0],[anchor.patchWidth-1,anchor.patchHeight-1],[0,anchor.patchHeight-1]].map(([x,y])=>point(anchor.matrix,x,y));
      if(directPose({id:anchor.id,proposal:{...anchor,corners},hint:planner.footprint(anchor),polygon:framePolygon,
        bounds:{x:0,y:0,right:width,bottom:height}}))stats.anchorHits++;
    }
    if(known.length)stats.seedFfts=0;
    stats.rememberedScale=Boolean(remembered&&!known.length);
    if(!known.length){
      replan=false;
      compute=data.hardwareSearch?(gpu||=new MarkerSearchGpu()):null;compute?.begin();
      stats.phase='initial-tree';
      await traverse();
    }
    // Revalidated guides or the first new header end discovery. The engine
    // retains its original huntSurface and runs the common guided resolver;
    // there is no local/broad half/quarter tree after any concrete header.
    stats.complete=true;stats.milliseconds=performance.now()-started;
    stats.afterSeedFfts=stats.seedFfts===null?0:stats.ffts-stats.seedFfts;
    self.postMessage({id:data.id,result:{markers:known,stats:{...stats,...backendStats()},trace}});
  }catch(error){self.postMessage({id:data.id,name:error?.name,error:error?.message||'Tree acquisition failed.'});}
  finally{compute?.end();for(const canvas of levels.values())canvas.width=canvas.height=1;levels.clear();}
};
