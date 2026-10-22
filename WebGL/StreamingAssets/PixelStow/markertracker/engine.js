// Shared whole-frame marker acquisition and GPU template tracking.
(function(root){
  'use strict';
  const defaultWorker=new URL('./acquire-worker.js?v=20261021-native-detail1',document.currentScript.src).href;
  const verifyWorker=new URL('./verify-worker.js?v=20261021-native-detail1',document.currentScript.src).href;
  const treeWorker=new URL('./tree-worker.js?v=20261021-native-detail1',document.currentScript.src).href;
  function MarkerEngine({onStatus,workerUrl=defaultWorker,acquisition='bsp',debugSearch=false,liveFeedback=false,hardwareSearch=false}={}){

    const names={0:'top left',2:'top right',6:'bottom left',8:'bottom right'},scales=[8,4,16,2];
    const reducers=[0,1].map(()=>{const canvas=document.createElement('canvas');return{canvas,context:canvas.getContext('2d',{alpha:false})};});
    const readback=document.createElement('canvas'),readbackContext=readback.getContext('2d',{willReadFrequently:true});
    const huntSurface=document.createElement('canvas'),huntContext=huntSurface.getContext('2d',{alpha:false});
    let generation=0,epoch=0,controller=null,tracks=[],mip=null,hunt=null,local=null;
    let view=null,crop=null,currentCrop=null,searchError=null,passes=0,disposed=false,capture=null,captureDelivered=false,statusText='Searching the whole picture.';
    let acquisitionBusy=false,acquisitionWorker=null,acquisitionWorkerUrl=null,acquisitionRequest=null,requestId=0;
    let treeMode=acquisition==='tree'||acquisition==='tree-binary',scalePrior=null,discovery=null,lastDiscovery=null,snapshots=0,searchNodes=[];
    function cameraScale(marker){
      const x=(marker.patchWidth-1)/2,y=(marker.patchHeight-1)/2,c=MarkerTrackerGeometry.point(marker.matrix,x,y);
      const u=MarkerTrackerGeometry.point(marker.matrix,x+1,y),v=MarkerTrackerGeometry.point(marker.matrix,x,y+1);
      return [Math.hypot(u.x-c.x,u.y-c.y),Math.hypot(v.x-c.x,v.y-c.y)];
    }
    const sameAperture=snapshot=>view.width===snapshot.w&&view.height===snapshot.h&&
      ['x','y','rawWidth','rawHeight'].every(key=>currentCrop?.[key]===snapshot.crop[key]);
    function say(text){statusText=text;onStatus?.(text);}
    function stopAcquisition() {
      acquisitionWorker?.terminate(); acquisitionWorker = null;acquisitionWorkerUrl=null;
      const pending = acquisitionRequest; acquisitionRequest = null;
      pending?.reject(new DOMException("Search cancelled.", "AbortError"));
    }

    function inWorker(operation, sample, signal, details = {}, onProgress) {
      if (signal.aborted) return Promise.reject(new DOMException("Search cancelled.", "AbortError"));
      const nextWorker=operation==='tree'?treeWorker:workerUrl;
      if(acquisitionWorker&&acquisitionWorkerUrl!==nextWorker)stopAcquisition();
      if (!acquisitionWorker) {
        acquisitionWorker = new Worker(nextWorker);acquisitionWorkerUrl=nextWorker;
        acquisitionWorker.onmessage = ({data}) => {
          const pending = acquisitionRequest;
          if (!pending || data.id !== pending.id) return;
          if(data.progress){pending.onProgress?.(data);return;}
          if(data.computeStats&&discovery){
            const s=data.computeStats;discovery.backend=s.backend;
            // Retain a failure even when later direct CPU header reads succeed.
            if(s.gpuUnavailable)discovery.gpuUnavailable=s.gpuUnavailable;
            if(s.gpuPilotSkipReason)discovery.gpuPilotSkipReason=s.gpuPilotSkipReason;
            for(const key of ['ffts','gpuFfts','gpuPilots','cpuFfts','cpuPilots','poseReads','poseChecks','poseHits','basisReads','basisHits',
              'workerMilliseconds','gpuMilliseconds','gpuReadbackMilliseconds','gpuInitMilliseconds','gpuSkippedPilots'])
              discovery[key]=(discovery[key]||0)+(s[key]||0);
            if(pending.operation==='guided'){
              discovery.guidedFfts=(discovery.guidedFfts||0)+s.ffts;
              discovery.guidedGpuFfts=(discovery.guidedGpuFfts||0)+s.gpuFfts;
              discovery.guidedGpuPilots=(discovery.guidedGpuPilots||0)+s.gpuPilots;
            }
            if(discovery.seedFfts!==null&&discovery.seedFfts!==undefined)discovery.afterSeedFfts=discovery.ffts-discovery.seedFfts;
          }
          acquisitionRequest = null;
          if (data.error) pending.reject(Object.assign(new Error(data.error),{name:data.name||"Error"})); else pending.resolve(data.result);
        };
        acquisitionWorker.onerror = () => {
          const pending = acquisitionRequest; acquisitionRequest = null;
          acquisitionWorker?.terminate(); acquisitionWorker = null;acquisitionWorkerUrl=null;
          pending?.reject(new Error("The acquisition worker failed. Reload this page."));
        };
      }
      return new Promise((resolve, reject) => {
        const id = ++requestId, abort = () => stopAcquisition();
        const finish = callback => value => { signal.removeEventListener("abort", abort); callback(value); };
        acquisitionRequest = {id,operation,resolve:finish(resolve),reject:finish(reject),onProgress};
        signal.addEventListener("abort", abort, {once:true});
        if(sample.bitmap)acquisitionWorker.postMessage({id,operation,hardwareSearch,...details,bitmap:sample.bitmap},[sample.bitmap]);
        else acquisitionWorker.postMessage({id,operation,hardwareSearch,...details,pixels:sample.pixels,width:sample.width,height:sample.height},[sample.pixels.buffer]);
      });
    }

    function clampRect(name, x, y, w, h, depth) {
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(hunt.w, Math.ceil(x + w)), y1 = Math.min(hunt.h, Math.ceil(y + h));
      const rw = x1 - x0, rh = y1 - y0;
      if (rw < 64 || rh < 64) return null;
      return { name, x: x0, y: y0, w: rw, h: rh, depth };
    }

    function halves(rect, nominal) {
      const horizontal = rect.w >= rect.h;
      let bleed = 0.12;
      const fits = extra => (horizontal ? rect.w : rect.h) / 2 * (1 + extra) / nominal <= 480;
      while (bleed > 0 && !fits(bleed)) bleed = Math.round((bleed - 0.04) * 100) / 100;
      const prefix = rect.name === "whole picture" ? "" : rect.name + " / ";
      const span = (horizontal ? rect.w : rect.h) / 2 * (1 + bleed);
      const spots = horizontal ? [["left half",rect.x,rect.y,span,rect.h],["right half",rect.x+rect.w-span,rect.y,span,rect.h]] :
        [["top half",rect.x,rect.y,rect.w,span],["bottom half",rect.x,rect.y+rect.h-span,rect.w,span]];
      return spots.map(([spot,x,y,w,h])=>{
        const result=clampRect(prefix+spot,x,y,w,h,rect.depth+1);
        return result && {...result,parent:rect.name};
      }).filter(Boolean);
    }

    function cover(rect, nominal) {
      if (Math.max(rect.w, rect.h) / nominal <= 480 || rect.depth >= 8) return [rect];
      const parts = halves(rect, nominal);
      if (parts.length < 2) return [rect];
      return parts.flatMap((part) => cover(part, nominal));
    }

    function beginHunt(width, height) {
      capture=null;captureDelivered=false;
      huntSurface.width = width; huntSurface.height = height; huntContext.drawImage(view,0,0);
      hunt = { w: width, h: height, scaleIndex: 0, queue: null, splits: 0, bestMiss: null,
        scales: local?.size && mip ? [mip] : scales,
        anchors: (local?.markers || []).filter(m=>local.items.get(m.id).misses===0).map(m => ({...m,matrix:m.matrix.slice()})), crop: {...crop}, started: performance.now() };
      hunt.pendingAnchors=hunt.anchors.slice();hunt.observations=[];
      hunt.capturedAt=hunt.started;
      snapshots++;
      discovery={mode:treeMode?'tree':'bsp',split:acquisition==='tree-binary'?'halves':'quarters',snapshot:snapshots,nodes:0,ffts:0,reads:0,scales:{},milliseconds:0,firstMs:null,complete:false,
        guidedTiles:0,guidedFfts:0,guidedGpuFfts:0,guidedGpuPilots:0,gpuFfts:0,gpuPilots:0,cpuFfts:0,cpuPilots:0,
        workerMilliseconds:0,gpuMilliseconds:0,gpuReadbackMilliseconds:0,gpuInitMilliseconds:0,gpuSkippedPilots:0,
        poseReads:0,poseChecks:0,poseHits:0,basisReads:0,basisHits:0};
      if(treeMode){
        hunt.mode='tree';searchNodes=[];
      }
      say('Searching capture #'+snapshots+'.');
    }

    function completeCapture(snapshot,markers){
      const seed=markers[0];
      if(markers.length!==4||new Set(markers.map(m=>m.id)).size!==4||markers.some(m=>![0,2,6,8].includes(m.id)||m.verification!=='header'||
        m.originalWidth!==seed.originalWidth||m.originalHeight!==seed.originalHeight||m.carrierVersion!==seed.carrierVersion))return false;
      capture={source:huntSurface,width:snapshot.w,height:snapshot.h,markers:markers.map(m=>({...m,matrix:m.matrix.slice()})),
        snapshot:snapshots,crop:{...snapshot.crop},capturedAt:snapshot.capturedAt,milliseconds:performance.now()-snapshot.capturedAt};
      discovery={...discovery,complete:true,captured:true,anchors:4,targetIds:[],targetRegions:[],milliseconds:capture.milliseconds};
      if(discovery.wallMs!==undefined)discovery.wallMs=capture.milliseconds;
      if(liveFeedback&&sameAperture(snapshot))for(const marker of markers)adoptMarker(marker,snapshot,marker.mip||1);
      lastDiscovery=discovery;hunt=null;passes++;
      say('Capture #'+capture.snapshot+' complete · 4/4 markers · '+Math.round(capture.milliseconds)+' ms.');return true;
    }

    function incompleteCapture(snapshot,markers){
      // Tracking only prepares the NEXT capture. It cannot alter or cancel the
      // completed search, or become a condition for accepting its four headers.
      if(sameAperture(snapshot)){
        if(local?.size){for(const r of local.update(view))if(r.lost)local.remove(r.marker.id);tracks=local.markers;}
        for(const marker of markers)adoptMarker(marker,snapshot,marker.mip||1);
      }
      hunt=null;passes++;
      say('Capture incomplete · '+markers.length+'/4 markers. Re-evaluating guides for the next capture.');
    }

    function guideHunt() {
      const known=hunt.observations,layout=PixelStow.getVisualMarkerLayout(known[0])?.filter(p=>[0,2,6,8].includes(p.id));
      const predicted=MarkerTrackerGeometry.predict(known,layout).filter(p=>!known.some(m=>m.id===p.id));
      hunt.mode='guided';hunt.queue=[];hunt.bestMiss=null;hunt.started=performance.now();
      if(discovery){
        discovery.phase='guided-markers';discovery.directional=true;discovery.guided=true;discovery.anchors=known.length;
        discovery.targetIds=[0,2,6,8].filter(id=>!known.some(m=>m.id===id));discovery.targetRegions=[];
        discovery.firstMs??=performance.now()-hunt.capturedAt;discovery.seedFfts??=discovery.ffts;discovery.complete=false;
      }
      // First check every missing ID tightly, then widen only those same regions.
      // Three corners never send discovery back to an already occupied corner.
      for(const expansion of [1,2.5])for(const proposal of predicted){
        const {corners,span,error}=proposal;
        const distance=Math.min(...known.map(m=>{const c=MarkerTrackerGeometry.point(m.matrix,(m.patchWidth-1)/2,(m.patchHeight-1)/2);
          const p=MarkerTrackerGeometry.point(proposal.matrix,(proposal.patchWidth-1)/2,(proposal.patchHeight-1)/2);return Math.hypot(c.x-p.x,c.y-p.y);}));
        const margin=expansion*(span*(known.length>=3?.45:known.length===2?.7:1)+error*4+(known.length===1?distance*.08:0));
        const x=Math.min(...corners.map(p=>p.x))-margin,y=Math.min(...corners.map(p=>p.y))-margin;
        const w=Math.max(...corners.map(p=>p.x))+margin-x,h=Math.max(...corners.map(p=>p.y))+margin-y;
        const rect=clampRect('missing '+(names[proposal.id]||proposal.id),x,y,w,h,0);
        if(!rect)continue;
        const basis=span/Math.max(proposal.patchWidth-1,proposal.patchHeight-1);
        const nominal=[1,2,4,8,16].reduce((best,n)=>Math.abs(Math.log2(basis/n))<Math.abs(Math.log2(basis/best))?n:best,1);
        hunt.queue.push(...cover(rect,nominal).map(part=>({...part,proposal,nominal})));
      }
    }

    function prime(nominal) {
      hunt.queue = halves({ name: "whole picture", x: 0, y: 0, w: hunt.w, h: hunt.h, depth: 0 },nominal).flatMap(part=>cover(part,nominal));
      hunt.splits = 0;
      hunt.bestMiss = null;
    }

    function pull() {
      if(hunt.mode==='guided'){
        const rect=hunt.queue.shift();return rect?{rect,nominal:rect.nominal}:null;
      }
      while (hunt.scaleIndex < hunt.scales.length) {
        const nominal = hunt.scales[hunt.scaleIndex];
        if (!hunt.queue) prime(nominal);
        if (hunt.queue.length) return { rect: hunt.queue.shift(), nominal };
        // A miss on a large area still has to be broken up. The marker can be
        // too small a fraction of the whole picture to pass on its own.
        const miss = hunt.bestMiss;
        if (hunt.splits < 4 && miss && miss.rect.depth < 6 && Math.max(miss.rect.w, miss.rect.h) > 480) {
          const kids = halves(miss.rect, nominal).filter((rect) => Math.max(rect.w, rect.h) / nominal <= 480);
          hunt.splits += 1;
          hunt.bestMiss = null;
          if (kids.length) { hunt.queue = kids; continue; }
        }
        hunt.scaleIndex += 1;
        hunt.queue = null;
        hunt.splits = 0;
        hunt.bestMiss = null;
      }
      return null;
    }

    function box2(pixels, width, height) {
      // The last halving is a true 2×2 average. A single hardware shrink would
      // blur the carrier the frequency check is trying to see.
      const dw = Math.max(1, Math.round(width / 2)), dh = Math.max(1, Math.round(height / 2));
      const out = new Uint8Array(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        const y0 = Math.min(height - 1, y * 2), y1 = Math.min(height, y0 + 2);
        for (let x = 0; x < dw; x++) {
          const x0 = Math.min(width - 1, x * 2), x1 = Math.min(width, x0 + 2);
          let r = 0, g = 0, b = 0, count = 0;
          for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
            const i = (sx + sy * width) * 4;
            r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; count++;
          }
          const o = (x + y * dw) * 4;
          out[o] = Math.round(r / count); out[o + 1] = Math.round(g / count); out[o + 2] = Math.round(b / count); out[o + 3] = 255;
        }
      }
      return { pixels: out, width: dw, height: dh };
    }

    function gpuSample(rect, nominal) {
      let source = huntSurface, sx = rect.x, sy = rect.y, sw = rect.w, sh = rect.h, slot = 0, factor = 1;
      while (factor * 2 < nominal) {
        const dw = Math.max(1, Math.round(sw / 2)), dh = Math.max(1, Math.round(sh / 2));
        const dest = reducers[slot];
        if (dest.canvas.width !== dw) dest.canvas.width = dw;
        if (dest.canvas.height !== dh) dest.canvas.height = dh;
        dest.context.imageSmoothingEnabled = true;
        dest.context.imageSmoothingQuality = "high";
        dest.context.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
        source = dest.canvas;
        sx = 0; sy = 0; sw = dw; sh = dh;
        slot ^= 1;
        factor *= 2;
      }
      // Keep the source/reduction canvases eligible for GPU drawing. Only this
      // bounded tile is transferred to a canvas intended for CPU readback.
      if (readback.width!==sw) readback.width=sw;
      if (readback.height!==sh) readback.height=sh;
      readbackContext.drawImage(source,sx,sy,sw,sh,0,0,sw,sh);
      const image = readbackContext.getImageData(0,0,sw,sh);
      const pixels = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      if (factor < nominal) return box2(pixels, sw, sh);
      return { pixels, width: sw, height: sh };
    }

    function widen(rect, nominal) {
      if (rect.name === "whole picture") return rect;
      let bleed = 0.18;
      while (bleed > 0 && Math.max(rect.w, rect.h) * (1 + bleed * 2) / nominal > 480) bleed = Math.round((bleed - 0.06) * 100) / 100;
      if (bleed <= 0) return rect;
      const grown = clampRect(rect.name, rect.x - rect.w * bleed, rect.y - rect.h * bleed, rect.w * (1 + bleed * 2), rect.h * (1 + bleed * 2), rect.depth);
      return grown || rect;
    }

    function liftMatrix(matrix, rect, sampleWidth, sampleHeight) {
      const px = rect.w / sampleWidth, py = rect.h / sampleHeight, ox = (px - 1) / 2, oy = (py - 1) / 2;
      const h = [px * matrix[0] + ox * matrix[6], px * matrix[1] + ox * matrix[7], px * matrix[2] + ox * matrix[8],
        py * matrix[3] + oy * matrix[6], py * matrix[4] + oy * matrix[7], py * matrix[5] + oy * matrix[8],
        matrix[6], matrix[7], matrix[8]];
      return [h[0] + rect.x * h[6], h[1] + rect.x * h[7], h[2] + rect.x * h[8],
        h[3] + rect.y * h[6], h[4] + rect.y * h[7], h[5] + rect.y * h[8], h[6], h[7], h[8]];
    }

    async function readTile(rect, nominal, signal) {
      const sample = gpuSample(rect, nominal);
      if (Math.min(sample.width, sample.height) < 48) return { sample, signature: null };
      const signature = await inWorker("signature", sample, signal);
      return { sample, signature };
    }

    async function locate(rect, nominal, signal) {
      const region = rect.proposal?rect:widen(rect, nominal);
      const sample = gpuSample(region, nominal);
      let found = null;
      if(discovery)discovery.reads++;
      try {
        if(rect.proposal){
          const px=region.w/sample.width,py=region.h/sample.height;
          const matrix=MarkerTrackerGeometry.multiply([1/px,0,(.5-region.x)/px-.5,0,1/py,(.5-region.y)/py-.5,0,0,1],rect.proposal.matrix);
          found=await inWorker('guided',sample,signal,{seed:{...rect.proposal,matrix},region:{x:region.x,y:region.y,w:region.w,h:region.h},knownIds:hunt.observations.map(m=>m.id)});
        }else found = await inWorker("locate", sample, signal);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (error?.name === "SearchLimit") return null;
        throw error;
      }
      const seed = found;
      if (!seed?.matrix) return null;
      const lift = (matrix) => liftMatrix(matrix, region, sample.width, sample.height);
      return { ...seed, mip: nominal, matrix: lift(seed.matrix), initialMatrix: seed.initialMatrix && lift(seed.initialMatrix) };
    }

    function adoptMarker(marker,snapshot,nominal){
      if(tracks.some(m=>m.id===marker.id))return;
      let pose=marker.matrix;
      const anchor=snapshot.anchors.find(m=>tracks.some(t=>t.id===m.id)&&local.items.get(m.id)?.misses===0);
      if(anchor){
        const current=tracks.find(t=>t.id===anchor.id);
        pose=MarkerTrackerGeometry.multiply(current.matrix,MarkerTrackerGeometry.multiply(PixelStowTransform.invert(anchor.matrix),marker.matrix));
      }else if(crop&&snapshot.crop){
        const dx=snapshot.crop.x-crop.x,dy=snapshot.crop.y-crop.y;
        pose=marker.matrix.map((v,i)=>i<3?v+dx*marker.matrix[i+6]:i<6?v+dy*marker.matrix[i+3]:v);
      }
      if(!local)local=new MarkerTrackerBank();
      local.acquire(huntSurface,marker,performance.now(),pose);
      // A verified snapshot observation still has to match the live camera.
      const check=local.items.get(marker.id).update(view);
      if(!check.locked){local.remove(marker.id);return;}
      tracks=local.markers;
      if(liveFeedback&&!snapshot.anchors.some(m=>m.id===marker.id))snapshot.anchors.push({...marker,matrix:marker.matrix.slice()});
      if(treeMode)scalePrior={...marker,matrix:pose.slice()};
      if(discovery?.firstMs===null)discovery.firstMs=performance.now()-snapshot.capturedAt;
      mip=nominal;
      say('Marker found ('+(names[marker.id]||marker.id)+'). Tracking '+tracks.length+'/4.');
    }

    async function searchTree(token){
      if(token!==generation||acquisitionBusy||!hunt||capture)return;
      acquisitionBusy=true;
      const attempt=epoch,snapshot=hunt;controller=new AbortController();
      const current=()=>token===generation&&attempt===epoch;
      try{
        if(typeof createImageBitmap!=='function'){
          treeMode=false;hunt=null;discovery={mode:'bsp',fallback:'Full-tree bitmap capture unavailable; using previous BSP.'};return;
        }
        let bitmap;
        try{bitmap=await createImageBitmap(huntSurface);}
        catch(error){
          if(!current())return;
          treeMode=false;hunt=null;discovery={mode:'bsp',fallback:'Worker bitmap capture unavailable; using previous BSP.'};return;
        }
        if(!current()){bitmap.close();return;}
        say('Pruned '+(acquisition==='tree-binary'?'binary':'quarter')+' tree · one captured frame.');
        const result=await inWorker('tree',{bitmap},controller.signal,{
          anchors:snapshot.anchors,scalePrior,debugSearch,liveFeedback,split:acquisition==='tree-binary'?'halves':'quarters',
          fruitlessMilliseconds:liveFeedback?2000:0
        },data=>{
          if(!current())return;
          discovery={...discovery,...data.stats,wallMs:performance.now()-snapshot.capturedAt};
          searchNodes.push(...data.trace);if(searchNodes.length>200)searchNodes.splice(0,searchNodes.length-200);
          if(hunt===snapshot)hunt.activeRect=data.rect;
          if(data.marker&&!snapshot.observations.some(m=>m.id===data.marker.id))snapshot.observations.push(data.marker);
          if(liveFeedback&&data.marker&&sameAperture(snapshot))adoptMarker(data.marker,snapshot,data.marker.mip);
          if(!data.marker)say('Searching capture #'+snapshots+' · '+data.stats.nodes+' regions checked.');
        });
        if(!current())return;
        if(result.unsupported){
          treeMode=false;hunt=null;stopAcquisition();discovery={mode:'bsp',fallback:'Worker canvas unavailable; using previous BSP.'};return;
        }
        discovery={...discovery,...result.stats,wallMs:performance.now()-snapshot.capturedAt};
        lastDiscovery={...discovery,scales:{...discovery.scales}};
        searchNodes.push(...result.trace);if(searchNodes.length>200)searchNodes.splice(0,searchNodes.length-200);
        if(result.stats?.abandoned&&!result.markers.length){
          incompleteCapture(snapshot,[]);
          if(liveFeedback)say('No marker within 2 s. Restarting from the current frame.');
          return;
        }
        if(!completeCapture(snapshot,result.markers)){
          if(result.markers.length){
            // Decode hides node-progress messages, but still needs its seed's
            // live tracker as soon as discovery returns the verified header.
            if(liveFeedback&&sameAperture(snapshot))for(const marker of result.markers)adoptMarker(marker,snapshot,marker.mip||1);
            // Transfer the verified seed(s), not a new camera frame, to exactly
            // the same predicted-region resolver used by Previous BSP.
            snapshot.observations=result.markers;snapshot.pendingAnchors=[];
            stopAcquisition();guideHunt();
          }else incompleteCapture(snapshot,result.markers);
        }
      }catch(error){
        if(!current()||error?.name==='AbortError')return;
        searchError=error?.message||'The full-tree search failed.';hunt=null;stopAcquisition();say(searchError+' Search again to retry.');
      }finally{
        acquisitionBusy=false;
        if(current()&&hunt===snapshot&&snapshot.mode==='guided'&&!capture)queueMicrotask(()=>searchStep(token));
      }
    }

    async function searchStep(token) {
      if (token!==generation || acquisitionBusy || !hunt || capture) return;
      acquisitionBusy = true;
      const attempt = epoch;
      const snapshot = hunt;
      controller = new AbortController();
      try {
        // A tracked pose is only a proposal for this newly captured raster.
        while(snapshot.pendingAnchors.length){
          const proposal=snapshot.pendingAnchors.shift(),corners=[[0,0],[proposal.patchWidth-1,0],[proposal.patchWidth-1,proposal.patchHeight-1],[0,proposal.patchHeight-1]]
            .map(([x,y])=>MarkerTrackerGeometry.point(proposal.matrix,x,y));
          const left=Math.min(...corners.map(p=>p.x)),top=Math.min(...corners.map(p=>p.y));
          const w=Math.max(...corners.map(p=>p.x))-left,h=Math.max(...corners.map(p=>p.y))-top;
          const rect=clampRect('checking tracked guide',left-w*.5,top-h*.5,w*2,h*2,0);
          if(!rect)continue;
          const pitch=Math.sqrt(cameraScale(proposal).reduce((a,b)=>a*b,1)),nominal=2**Math.max(0,Math.round(Math.log2(pitch)));
          const sample=gpuSample(rect,nominal),sx=rect.w/sample.width,sy=rect.h/sample.height;
          const matrix=MarkerTrackerGeometry.multiply([1/sx,0,(.5-rect.x)/sx-.5,0,1/sy,(.5-rect.y)/sy-.5,0,0,1],proposal.matrix);
          const read=await inWorker('anchor',sample,controller.signal,{seed:{...proposal,matrix}});
          if(token!==generation||attempt!==epoch)return;
          const same=snapshot.observations[0];
          if(read?.id===proposal.id&&read.originalWidth===proposal.originalWidth&&read.originalHeight===proposal.originalHeight&&
            (!same||(read.originalWidth===same.originalWidth&&read.originalHeight===same.originalHeight&&read.carrierVersion===same.carrierVersion)))
            snapshot.observations.push({...read,matrix:liftMatrix(read.matrix,rect,sample.width,sample.height),mip:nominal});
        }
        if(snapshot.observations.length===4){completeCapture(snapshot,snapshot.observations);return;}
        if(!snapshot.mode&&snapshot.observations.length)guideHunt();
        let tile = null, exhausted = false;
        for (let guard = 0; guard < 16 && !tile; guard++) {
          const next = pull();
          if (!next) { exhausted = true; break; }
          if (Math.min(next.rect.w, next.rect.h) < 64) continue;
          if (Math.max(next.rect.w, next.rect.h) / next.nominal > 512) {
            if (next.rect.depth < 8) hunt.queue.unshift(...halves(next.rect, next.nominal));
            continue;
          }
          tile = next;
        }
        if (token !== generation || attempt !== epoch) return;
        if (exhausted) {
          if(discovery){discovery.complete=true;discovery.milliseconds=performance.now()-snapshot.capturedAt;}
          lastDiscovery=discovery&&{...discovery,scales:{...discovery.scales}};
          incompleteCapture(snapshot,snapshot.observations);
          return;
        }
        if (!tile) return;
        hunt.activeRect = tile.rect;
        if(discovery){
          if(tile.rect.proposal)discovery.guidedTiles++;else discovery.nodes++;
          discovery.scales[tile.nominal]=(discovery.scales[tile.nominal]||0)+1;
        }
        if (debugSearch) say("Searching snapshot · 1/" + tile.nominal + " · " + tile.rect.name + ".");
        if (!tile.rect.proposal) {
          if (!tile.rect.signature) tile.rect.signature=(await readTile(tile.rect,tile.nominal,controller.signal)).signature || {likely:false};
          if (token!==generation || attempt!==epoch) return;
          const siblingIndex=hunt.queue.findIndex(r=>r.parent===tile.rect.parent && !r.signature);
          if (siblingIndex>=0) {
            const sibling=hunt.queue.splice(siblingIndex,1)[0];
            sibling.signature=(await readTile(sibling,tile.nominal,controller.signal)).signature || {likely:false};
            if (token!==generation || attempt!==epoch) return;
            if ((sibling.signature.prominence||0)>(tile.rect.signature.prominence||0)) {
              hunt.queue.unshift(tile.rect); tile={rect:sibling,nominal:tile.nominal};
            } else hunt.queue.unshift(sibling);
          }
          const signature=tile.rect.signature;
          if (token !== generation || attempt !== epoch) return;
          const prominence = signature?.prominence || 0;
          if (!signature?.likely) {
            if (!hunt.bestMiss || prominence > hunt.bestMiss.prominence) hunt.bestMiss = { rect: tile.rect, prominence };
            if (debugSearch) say("No signature in " + tile.rect.name + " at 1/" + tile.nominal + ".");
            return;
          }
        }
        if (debugSearch) say("Reading a marker in " + tile.rect.name + " at 1/" + tile.nominal + ".");
        const marker = await locate(tile.rect, tile.nominal, controller.signal);
        if (token !== generation || attempt !== epoch) return;
        if (!marker) {
          if (!tile.rect.proposal && hunt.splits < 4 && tile.rect.depth < 6 && Math.max(tile.rect.w, tile.rect.h) > 480) {
            const kids = halves(tile.rect, tile.nominal).filter((rect) => Math.max(rect.w, rect.h) / tile.nominal <= 480);
            if (kids.length) { hunt.queue.unshift(...kids); hunt.splits += 1; }
          }
          if (debugSearch) say(tile.rect.proposal ? "Missing corner not readable here. Checking the next projected region." : "No readable marker in this tile. Continuing the split.");
          return;
        }
        if(![0,2,6,8].includes(marker.id)||marker.verification!=='header')return;
        const same = snapshot.observations[0];
        if (same && (same.originalWidth!==marker.originalWidth || same.originalHeight!==marker.originalHeight || same.carrierVersion!==marker.carrierVersion)) return;
        // One header gives dimensions, ID and local axes. Replace the broad tree
        // immediately with the missing corners; refine that plane on every hit.
        if(!snapshot.observations.some(m=>m.id===marker.id)){
          snapshot.observations.push(marker);guideHunt();
          if(liveFeedback&&sameAperture(snapshot))adoptMarker(marker,snapshot,tile.nominal);
        }
        if(snapshot.observations.length===4)completeCapture(snapshot,snapshot.observations);
      } catch (error) {
        if (token !== generation || attempt !== epoch || error?.name === "AbortError") return;
        searchError=error?.message || "The marker search failed."; hunt=null; stopAcquisition();
        say(searchError + " Restart scanning to retry.");
      } finally {
        acquisitionBusy = false;
        if (token === generation && attempt === epoch && hunt===snapshot && !capture)
          queueMicrotask(()=>searchStep(token));
      }
    }

    function resetSearch(){epoch++;controller?.abort();stopAcquisition();hunt=null;capture=null;captureDelivered=false;searchError=null;}
    function reset(){
      generation++;resetSearch();local?.dispose();local=null;tracks=[];mip=null;scalePrior=null;crop=null;currentCrop=null;passes=0;discovery=null;lastDiscovery=null;searchNodes=[];snapshots=0;
      statusText='Searching the whole picture.';
    }
    function update(source,time=performance.now(),coordinates={},{allowSearch=true}={}){
      if(disposed)throw Error('The marker engine is closed.');
      const next={x:coordinates.x||0,y:coordinates.y||0,rawWidth:coordinates.rawWidth||source.width,rawHeight:coordinates.rawHeight||source.height};
      if(!hunt&&!acquisitionBusy&&(!capture||liveFeedback&&captureDelivered)){
        if(crop&&(crop.rawWidth!==next.rawWidth||crop.rawHeight!==next.rawHeight))reset();
        if(crop&&(crop.x!==next.x||crop.y!==next.y)){
          local?.reframe(crop.x-next.x,crop.y-next.y);resetSearch();
        }
        crop=next;
      }
      currentCrop=next;view=source;
      // A fruitful read finishes inside two seconds. A tree that is still
      // descending with no verified header is searching a stale frame.
      if(liveFeedback&&acquisitionBusy&&hunt?.mode==='tree'&&!hunt.observations.length&&
        discovery?.firstMs==null&&performance.now()-hunt.capturedAt>2500){
        epoch++;hunt=null;controller?.abort();
        say('No marker within 2 s. Restarting from the current frame.');
      }
      if(discovery&&hunt){
        discovery.milliseconds=performance.now()-hunt.capturedAt;
        if(discovery.wallMs!==undefined)discovery.wallMs=discovery.milliseconds;
      }
      if(discovery?.mode==='bsp'&&!discovery.complete){
        discovery.milliseconds=hunt?performance.now()-hunt.capturedAt:discovery.milliseconds;
        if(!hunt){discovery.complete=true;lastDiscovery={...discovery,scales:{...discovery.scales}};}
      }
      const trackLive=liveFeedback&&(!hunt||sameAperture(hunt));
      const results=local?.size&&(trackLive||!hunt&&!acquisitionBusy&&!capture)?local.update(view,time):[];
      for(const result of results)if(result.lost)local.remove(result.marker.id);
      tracks=local?.markers||[];
      if(treeMode){
        const measured=results.find(r=>r.locked&&!r.lost)?.marker;
        if(measured)scalePrior={...measured,matrix:measured.matrix.slice()};
      }
      const needsSearch=liveFeedback?(!capture||captureDelivered)&&tracks.length<4:!capture;
      const waitingForStability=!acquisitionBusy&&!hunt&&needsSearch&&!searchError&&!allowSearch;
      if(!acquisitionBusy&&needsSearch&&!searchError){
        if(!hunt&&allowSearch)beginHunt(source.width,source.height);
        // Once admitted, a pass continues on its retained buffer even if the
        // live image starts moving. Admission only governs NEW snapshots.
        if(hunt){if(treeMode&&hunt.mode!=='guided')searchTree(generation);else searchStep(generation);}
      }
      const capturedSquares=liveFeedback?null:capture?.markers.map(m=>({id:m.id,corners:[[0,0],[m.patchWidth-1,0],[m.patchWidth-1,m.patchHeight-1],[0,m.patchHeight-1]]
        .map(([x,y])=>MarkerTrackerGeometry.point(m.matrix,x,y))}));
      if(capture)captureDelivered=true;
      return {width:liveFeedback?source.width:capture?.width||source.width,height:liveFeedback?source.height:capture?.height||source.height,results,capture,
        tracks:!liveFeedback&&capture?capture.markers:(trackLive||!hunt&&!acquisitionBusy?tracks.map(m=>({...m,ghost:local.items.get(m.id).misses>0})):[]),
        markers:!liveFeedback&&capture?capture.markers:results.filter(r=>r.locked&&!r.lost).map(r=>r.marker),
        squares:!liveFeedback&&capturedSquares?capturedSquares:results.flatMap(r=>r.squares),region:debugSearch?hunt?.activeRect:null,
        searchFrame:debugSearch&&hunt?{source:huntSurface,snapshot:snapshots,markers:hunt.observations}:null,
        passes,waitingForStability,searchError,status:statusText,discovery,lastDiscovery,searchNodes};
    }
    this.update=update;this.reset=reset;this.resetSearch=resetSearch;
    this.setDebugSearch=enabled=>{debugSearch=Boolean(enabled);};
    this.dispose=()=>{if(!disposed){reset();disposed=true;}};

  }
  MarkerEngine.makeScan=(image,proposals)=>root.PixelStowMarkerScan(image,proposals);
  MarkerEngine.makeTrackedScan=(image,proposals)=>root.PixelStowMarkerScan(image,proposals,{verifyHeaders:false});
  MarkerEngine.makeCaptureScan=(image,proposals)=>root.PixelStowMarkerScan(image,proposals,{verifyHeaders:false,capturedHeaders:true});
  MarkerEngine.verifyFrame=function(source,proposals,{signal}={}){
    // Freeze before yielding: coordinates and pixels must belong to the same
    // tracker update. Never read back the live GPU tracking canvas itself.
    if(signal?.aborted)return Promise.reject(new DOMException('Capture cancelled.','AbortError'));
    const snapshot=document.createElement('canvas');snapshot.width=source.width;snapshot.height=source.height;
    const context=snapshot.getContext('2d',{alpha:false});context.drawImage(source,0,0);
    return new Promise((resolve,reject)=>{
      let worker,finished=false,timer;
      const cleanup=()=>{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker?.terminate();snapshot.width=snapshot.height=0;};
      const fail=error=>{if(!finished){cleanup();reject(error);}};
      const abort=()=>fail(new DOMException('Capture cancelled.','AbortError'));
      const sendPixels=()=>{
        const readback=document.createElement('canvas');readback.width=snapshot.width;readback.height=snapshot.height;
        const ctx=readback.getContext('2d',{willReadFrequently:true});ctx.drawImage(snapshot,0,0);
        const pixels=new Uint8Array(ctx.getImageData(0,0,readback.width,readback.height).data.buffer);
        worker.postMessage({pixels,width:readback.width,height:readback.height,proposals},[pixels.buffer]);readback.width=readback.height=0;
      };
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>fail(new Error('Capture verification timed out')),10000);
      try{
        worker=new Worker(verifyWorker);
        worker.onerror=()=>fail(new Error('The capture verifier could not start'));
        worker.onmessage=({data})=>{
          if(finished)return;
          if(data.needsPixels){try{sendPixels();}catch(error){fail(error);}return;}
          if(data.error){fail(new Error(data.error));return;}
          cleanup();resolve(data.result);
        };
        if(typeof createImageBitmap==='function'){
          Promise.resolve().then(()=>createImageBitmap(snapshot)).then(bitmap=>{
            if(finished){bitmap.close();return;}
            try{worker.postMessage({bitmap,proposals},[bitmap]);}
            catch{bitmap.close();try{sendPixels();}catch(error){fail(error);}}
          },()=>{if(!finished){try{sendPixels();}catch(error){fail(error);}}});
        }else sendPixels();
      }catch(error){fail(error);}
    });
  };
  MarkerEngine.acquireFrame=async function(image,{signal,onProgress,maxMilliseconds=20000}={}){
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    canvas.getContext('2d',{alpha:false}).putImageData(new ImageData(new Uint8ClampedArray(image.pixels.buffer,image.pixels.byteOffset,image.pixels.byteLength),image.width,image.height),0,0);
    // Manual PixelStow captures use the same GPU halves acquisition as live Decode,
    // independently of defaults or acquisition experiments in the lab.
    const engine=new MarkerEngine({acquisition:'tree-binary',hardwareSearch:true,onStatus:onProgress}),deadline=performance.now()+maxMilliseconds;
    const abort=()=>engine.dispose();signal?.addEventListener('abort',abort,{once:true});
    let state;
    try{
      do{
        if(signal?.aborted)throw new DOMException('Capture cancelled.','AbortError');
        state=engine.update(canvas);
        if(state.capture||state.passes||state.searchError)break;
        await new Promise(resolve=>setTimeout(resolve,33));
      }while(performance.now()<deadline);
      if(signal?.aborted)throw new DOMException('Capture cancelled.','AbortError');
      if(state.searchError)throw Error(state.searchError);
      return state.capture?MarkerEngine.makeCaptureScan(image,state.capture.markers):MarkerEngine.makeScan(image,state.markers);
    }finally{signal?.removeEventListener('abort',abort);engine.dispose();canvas.width=canvas.height=0;}
  };
  root.PixelStowMarkerEngine=MarkerEngine;
})(window);
