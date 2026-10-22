// Native readback and repeated header/CRC checks do not run in the frame loop.
importScripts('../pixelstow-spectrum.js?v=20261017-quad1','../pixelstow-transform.js?v=20261019-v6-native1','../pixelstow.js?v=20261021-native-detail1',
  './geometry.js?v=20261018-parity1','./scan.js?v=20261018-lock-capture1');
self.onmessage=({data})=>{
  try{
    let image;
    if(data.bitmap){
      if(typeof OffscreenCanvas==='undefined'){
        data.bitmap.close();self.postMessage({needsPixels:true});return;
      }
      const bitmap=data.bitmap;
      let canvas,context;
      try{canvas=new OffscreenCanvas(bitmap.width,bitmap.height);context=canvas.getContext('2d',{willReadFrequently:true,alpha:false});}catch{}
      if(!context){bitmap.close();self.postMessage({needsPixels:true});return;}
      context.drawImage(bitmap,0,0);bitmap.close();
      image={pixels:new Uint8Array(context.getImageData(0,0,canvas.width,canvas.height).data.buffer),width:canvas.width,height:canvas.height,exact:true};
      canvas.width=canvas.height=0;
    }else image={pixels:data.pixels,width:data.width,height:data.height,exact:true};
    const scan=PixelStowMarkerScan(image,data.proposals);
    if(scan.markers.length<3||!scan.candidates.length){self.postMessage({result:null});return;}
    self.postMessage({result:{image,scan}},[image.pixels.buffer]);
  }catch(error){data.bitmap?.close();self.postMessage({error:error?.message||'Capture verification failed'});}
};
