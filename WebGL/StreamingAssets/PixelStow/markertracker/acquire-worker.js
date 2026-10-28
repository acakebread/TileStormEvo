// Copyright 2026 massivehadron.com ltd.

// Bounded acquisition and the shared post-seed resolver. Local fitting and
// header CRC stay on the CPU; FFT and marker pilot maps can use WebGL2.
importScripts('../pixelstow-spectrum.js?v=20261019-guided1','../pixelstow-transform.js?v=20261019-v6-native1','../pixelstow.js?v=20261021-native-detail1','./search-gpu.js?v=20261019-gpu-output1');
let gpu=null;
self.onmessage = async ({data}) => {
  const started=performance.now();
  let compute=null;
  const hardware=()=>{
    if(!data.hardwareSearch)return null;
    if(!compute){compute=gpu||=new MarkerSearchGpu();compute.begin();}
    return compute;
  };
  const stats={ffts:0,pilotMaps:0,poseReads:0,poseChecks:0,poseHits:0,basisReads:0,basisHits:0};
  const searchCompute={
    spectrum(...args){stats.ffts++;return hardware()?.spectrum(...args)??null;},
    candidates(...args){stats.pilotMaps++;return hardware()?.candidates(...args)??null;}
  };
  const metrics=()=>{
    const actual=compute?.stats||{backend:data.hardwareSearch?'GPU requested · direct CPU headers':'CPU',
      gpuFfts:0,gpuPilots:0};
    return {...stats,...actual,workerMilliseconds:performance.now()-started,cpuFfts:stats.ffts-actual.gpuFfts,cpuPilots:stats.pilotMaps-actual.gpuPilots};
  };
  try {
    let result;
    if (data.operation === 'signature') {
      const luma = new Float32Array(data.width * data.height);
      for (let i=0;i<luma.length;i++) luma[i]=(data.pixels[i*4]+data.pixels[i*4+1]+data.pixels[i*4+2])/3;
      result = await PixelStowSpectrum.analyze(luma,data.width,data.height,{fast:true,searchCompute,markerRatios:[4/5],check(){}});
    } else if(data.operation==='guided'||data.operation==='anchor') {
      // A projected corner is only a proposal. Its own header/CRC must read.
      const seed=data.seed,offsets=[0,-.5,.5,-1,1,-2,2];result=null;stats.poseReads++;
      for(const dy of offsets){
        for(const dx of offsets){
          const h=seed.matrix,matrix=h.map((v,i)=>i<3?v+dx*h[i+6]:i<6?v+dy*h[i+3]:v);
          stats.poseChecks++;
          result=PixelStow.readVisualMarker(data.pixels,data.width,data.height,{...seed,matrix});
          if(result)break;
        }if(result)break;
      }
      if(result)stats.poseHits++;
      const matching=found=>found?.markers?.find(m=>m.id===seed.id&&m.verification==='header'&&m.originalWidth===seed.originalWidth&&
        m.originalHeight===seed.originalHeight&&m.carrierVersion===seed.carrierVersion)||null;
      const options={worker:false,geometryOnly:true,fast:true,searchCompute,
        singleResolution:true,scaleGuide:false,seedOnly:true,frequencyOnly:true,
        mode:'perspective',edgeBand:.5,camera:true,carrierVersion:seed.carrierVersion};
      if(!result&&data.operation==='guided'&&hardware()?.gl){
        // Search translation with concrete axes/size before asking an FFT to
        // rediscover them. The GPU locates pilot peaks; the existing CPU fitter
        // and CRC reader still verify them. Failed attempts keep the old path.
        const h=seed.matrix,x=(seed.patchWidth-1)/2,y=(seed.patchHeight-1)/2;
        const point=(x,y)=>{const d=h[6]*x+h[7]*y+h[8];return[(h[0]*x+h[1]*y+h[2])/d,(h[3]*x+h[4]*y+h[5])/d];};
        const c=point(x,y),u=point(x+1,y),v=point(x,y+1),basis=[u[0]-c[0],u[1]-c[1],v[0]-c[0],v[1]-c[1]];
        if(basis.every(Number.isFinite)){
          stats.basisReads++;
          try{
            result=matching(await PixelStow.findVisualTransform(data.pixels,data.width,data.height,{
              ...options,continuousWorker:true,deadline:Date.now()+200,maxMilliseconds:200,frequencySignature:{likely:true,bases:[basis]},
              frequencyBankLimit:1,seedRefinements:8,forceSearch:false
            }));
            if(result)stats.basisHits++;
          }catch(error){if(error?.name!=='SearchLimit')throw error;}
        }
      }
      if(!result&&data.operation==='guided'){
        // Same bounded predicted-region locator as Previous BSP. Hardware can
        // accelerate its FFT and pilot maps too; this never enters a BSP tree.
        result=matching(await PixelStow.findVisualTransform(data.pixels,data.width,data.height,{
          ...options,deadline:Date.now()+700,maxMilliseconds:700,forceSearch:true
        }));
      }
    } else {
      const found = await PixelStow.findVisualTransform(data.pixels,data.width,data.height,{
        deadline:Date.now()+5000,maxMilliseconds:5000,worker:false,geometryOnly:true,fast:true,searchCompute,
        singleResolution:true,scaleGuide:false,seedOnly:true,frequencyOnly:true,forceSearch:false,
        mode:'perspective',edgeBand:.5,camera:true
      });
      result=found?.markers?.[0] || null;
    }
    self.postMessage({id:data.id,result,computeStats:metrics()});
  } catch(error) {self.postMessage({id:data.id,name:error?.name,error:error?.message || 'Acquisition failed.',computeStats:metrics()});}
  finally{compute?.end();}
};
