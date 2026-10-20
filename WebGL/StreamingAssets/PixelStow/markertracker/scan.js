// Pure exact-raster header verification, shared by the UI and verification worker.
(function(root){
  'use strict';
  // Frozen/manual searches verify headers. Automatic capture can instead use
  // current live template matches of identities already verified on acquisition.
  // Those are pattern observations, never claimed as freshly read headers.
  root.PixelStowMarkerScan=function(image,proposals,{verifyHeaders=true,capturedHeaders=false}={}){
    // capturedHeaders is reserved for the engine's immutable acquisition raster:
    // its own headers were already CRC-read there, including every tracked guide.
    const markers=capturedHeaders?proposals.filter(m=>m.verification==='header').map(m=>({...m,matrix:m.matrix.slice()})):verifyHeaders?proposals.map(m=>{
      const a=MarkerTrackerGeometry.point(m.matrix,0,0),b=MarkerTrackerGeometry.point(m.matrix,m.patchWidth-1,0);
      const pitch=Math.hypot(b.x-a.x,b.y-a.y)/(m.patchWidth-1),offsets=[0,-.25,.25,-.5,.5,-1,1];
      for(const y of offsets)for(const x of offsets){
        const h=m.matrix,dx=x*pitch,dy=y*pitch,matrix=h.map((v,i)=>i<3?v+dx*h[i+6]:i<6?v+dy*h[i+3]:v);
        const read=PixelStow.readVisualMarker(image.pixels,image.width,image.height,{...m,matrix});
        if(read)return read;
      }
      return null;
    }).filter(Boolean):proposals.filter(m=>!m.ghost).map(m=>({...m,verification:'pattern',localized:true,tracked:true}));
    const headerCount=markers.filter(m=>m.verification==='header').length;
    const seed=markers[0],layout=seed&&PixelStow.getVisualMarkerLayout(seed)?.filter(p=>[0,2,6,8].includes(p.id));
    const predicted=markers.length>=2?MarkerTrackerGeometry.predict(markers,layout):[];
    let geometry=null;
    if(predicted.length){
      const patch=predicted[0],spot=layout.find(p=>p.id===patch.id);
      const matrix=MarkerTrackerGeometry.multiply(patch.matrix,[1,0,-spot.x,0,1,-spot.y,0,0,1]);
      const scale=markers.reduce((sum,m)=>{
        const a=MarkerTrackerGeometry.point(m.matrix,0,0),b=MarkerTrackerGeometry.point(m.matrix,m.patchWidth-1,0);
        return sum+Math.hypot(b.x-a.x,b.y-a.y)/(m.patchWidth-1);
      },0)/markers.length;
      const fitError=patch.error/scale,quality=markers.reduce((sum,m)=>sum+m.quality,0)/markers.length;
      const positions=layout.filter(p=>markers.some(m=>m.id===p.id));
      const coverage=(Math.max(...positions.map(p=>p.x))-Math.min(...positions.map(p=>p.x)))/seed.originalWidth*
        (Math.max(...positions.map(p=>p.y))-Math.min(...positions.map(p=>p.y)))/seed.originalHeight;
      if(fitError<2.5)geometry={matrix,originalWidth:seed.originalWidth,originalHeight:seed.originalHeight,carrierVersion:seed.carrierVersion,
        model:'perspective',patchWidth:seed.patchWidth,patchHeight:seed.patchHeight,markerTotal:4,markerCount:markers.length,
        headerCount,patternCount:markers.length-headerCount,inlierCount:markers.length,patternQuality:quality,coverage,fitError,
        missingMarkerIds:layout.filter(p=>!markers.some(m=>m.id===p.id)).map(p=>p.id),misalignedMarkerIds:[],
        rank:100*quality+4*markers.length+10*coverage-2*fitError,
        highConfidence:markers.length===4&&quality>=.9&&fitError<=.6&&coverage>=.6,
        expectedMarkers:predicted.map(({id,matrix,patchWidth,patchHeight})=>({id,matrix,patchWidth,patchHeight})),
        corners:[[0,0],[seed.originalWidth-1,0],[seed.originalWidth-1,seed.originalHeight-1],[0,seed.originalHeight-1]]
          .map(([x,y])=>MarkerTrackerGeometry.point(matrix,x,y))};
    }
    return {width:image.width,height:image.height,markers,geometry,
      candidates:geometry?[{geometry,markers,photo:true}]:[],highConfidence:Boolean(geometry?.highConfidence),
      signature:{likely:markers.length>0,confirmed:markers.length>0,message:markers.length+(verifyHeaders||capturedHeaders?' verified':' tracked')+' markers in this capture.'},
      reason:markers.length&&!geometry?'The captured corners did not fit a valid image plane.':undefined,
      algorithm:'whole-frame-binary'};
  };
})(typeof window!=='undefined'?window:self);
