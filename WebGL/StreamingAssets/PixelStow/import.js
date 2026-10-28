// Copyright 2026 massivehadron.com ltd.

// Thin game adapter around the unmodified PixelStow V6 snapshot. No level schema here.
(()=>{
 'use strict';
 const $=id=>document.getElementById(id),status=$('status'),video=$('video'),preview=$('preview'),password=$('password');
 let operation=null,image=null,stream=null,busy=false,closed=false,session=null;
 PixelStow.setCarrierVersion(6);PixelStow.setLegacyRecovery(false);
 const say=text=>{status.textContent=text;};
 function cameraOff(){stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;video.hidden=true;$('capture').hidden=true;}
 function reset(){operation?.abort();operation=new AbortController();image?.pixels.fill(0);image=null;password.value='';$('passwordForm').hidden=true;}
 function setBusy(value){busy=value;for(const id of ['browse','camera','capture'])$(id).disabled=value;}
 function post(data){parent.postMessage({pixelStow:1,session,...data},location.origin);}
 function finish(data){if(closed)return;closed=true;operation?.abort();cameraOff();password.value='';image?.pixels.fill(0);image=null;post(data);}
 const base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
 async function deliver(key=''){
  const options={carrierVersion:6,includeLegacy:false,signal:operation.signal,onProgress:say};
  const content=await PixelStow.decode(image.pixels,image.width,image.height,key,options);password.value='';
  if(content.status==='password'||content.status==='incorrect'){
   $('passwordForm').hidden=false;password.focus();say(content.status==='incorrect'?'That password did not unlock the image.':'This image is password protected.');return;
  }
  if(content.status!=='success'||content.carrierVersion!==6)throw Error('The V6 payload did not pass its checks. Try a clearer capture with all four corners visible.');
  const files=content.attachments.map(f=>({name:f.name,type:f.type,base64:base64(f.bytes)}));
  content.attachments.forEach(f=>f.bytes.fill(0));
  finish({kind:'decoded',text:content.text,files});
 }
 async function read(next){
  reset();image=next;setBusy(true);cameraOff();preview.width=next.width;preview.height=next.height;
  preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(next.pixels),next.width,next.height),0,0);preview.hidden=false;
  try{
   say('Checking the V6 payload…');const options={carrierVersion:6,includeLegacy:false,signal:operation.signal,onProgress:say};
   let found=await PixelStow.inspectNativeFile(next.pixels,next.width,next.height,options);
   if(!found.found||found.unreadable){
    say('Finding corner markers in this photograph…');
    const scan=await PixelStowMarkerEngine.acquireFrame(next,{signal:operation.signal,onProgress:say});
    found=await PixelStow.readMarkerCandidates(next.pixels,next.width,next.height,scan,options);
   }
   if(!found.found||found.unreadable)throw Error('No readable V6 payload was found. Try a clearer image with all four corner markers visible.');
   await deliver();
  }catch(error){if(error.name!=='AbortError')say(error.message||'The image could not be decoded.');}
  finally{setBusy(false);}
 }
 async function fileRead(file){if(busy||!file)return;setBusy(true);try{const next=await PixelStow.readImageFile(file);if(!closed)await read(next);}catch(error){say(error.message);}finally{setBusy(false);}}
 async function openCamera(){
  if(busy)return;reset();cameraOff();preview.hidden=true;
  const request=operation;setBusy(true);
  try{say('Opening camera…');const opened=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1440}},audio:false});
   if(closed||request.signal.aborted||document.hidden){opened.getTracks().forEach(t=>t.stop());return;}stream=opened;video.srcObject=stream;await video.play();video.hidden=false;$('capture').hidden=false;say('Frame the encoded image with all four corners visible, then capture.');
  }catch(error){cameraOff();say('Camera unavailable: '+error.message+'. You can choose a saved photograph instead.');}
  finally{setBusy(false);}
 }
 $('close').onclick=()=>finish({kind:'cancel'});
 $('browse').onclick=()=>{$('file').value='';$('file').click();};$('file').onchange=()=>fileRead($('file').files[0]);
 $('camera').onclick=openCamera;
 $('capture').onclick=()=>{if(busy||video.readyState<2)return;const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;read({pixels,width:c.width,height:c.height});};
 $('passwordForm').onsubmit=async event=>{event.preventDefault();if(busy||!image)return;const key=password.value;password.value='';setBusy(true);try{await deliver(key);}catch(error){say(error.message);}finally{setBusy(false);}};
 document.addEventListener('paste',event=>{if(busy)return;const file=Array.from(event.clipboardData?.items||[]).find(i=>i.type.startsWith('image/'))?.getAsFile();if(file){event.preventDefault();fileRead(file);}});
 document.addEventListener('dragover',event=>event.preventDefault());document.addEventListener('drop',event=>{event.preventDefault();fileRead(event.dataTransfer.files[0]);});
 window.addEventListener('pagehide',()=>{operation?.abort();cameraOff();password.value='';});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)cameraOff();});
 window.addEventListener('message',async event=>{
  if(event.source!==parent||event.origin!==location.origin||event.data?.pixelStow!==1||session!==null)return;
  session=event.data.session;
  if(event.data.base64){try{const bytes=Uint8Array.from(atob(event.data.base64),c=>c.charCodeAt(0));await fileRead(new File([bytes],'imported-image'));bytes.fill(0);}catch(error){say(error.message);}}
  else if(event.data.mode==='camera')say('Tap Open camera to start camera capture.');
 });
 post({kind:'ready'});
})();
