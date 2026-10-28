// Copyright 2026 massivehadron.com ltd.

// Spatial constraints for the lab worker. Predictions narrow possible regions;
// known corner topology prevents widening into an occupied, impossible corner.
(function(root){
  'use strict';
  const ids=[0,2,6,8],point=root.MarkerTrackerGeometry.point;
  const unit=id=>({x:id===2||id===8?1:0,y:id>=6?1:0});
  const cross=(a,b,p)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  const centre=m=>point(m.matrix,(m.patchWidth-1)/2,(m.patchHeight-1)/2);
  const bounds=poly=>({x:Math.min(...poly.map(p=>p.x)),y:Math.min(...poly.map(p=>p.y)),
    right:Math.max(...poly.map(p=>p.x)),bottom:Math.max(...poly.map(p=>p.y))});
  function clip(poly,a,b,c){
    const out=[];
    for(let i=0;i<poly.length;i++){
      const p=poly[i],q=poly[(i+1)%poly.length],u=a*p.x+b*p.y+c,v=a*q.x+b*q.y+c;
      if(u>=0)out.push(p);
      if((u>=0)!==(v>=0)){const t=u/(u-v);out.push({x:p.x+t*(q.x-p.x),y:p.y+t*(q.y-p.y)});}
    }
    return out;
  }
  function rectangle(poly,r){
    for(const [a,b,c] of [[1,0,-r.x],[-1,0,r.right],[0,1,-r.y],[0,-1,r.bottom]])poly=clip(poly,a,b,c);
    return poly;
  }
  const area=poly=>Math.abs(poly.reduce((s,p,i)=>{const q=poly[(i+1)%poly.length];return s+p.x*q.y-p.y*q.x;},0))/2;
  function contains(poly,p){
    let positive=false,negative=false;
    for(let i=0;i<poly.length;i++){
      const side=cross(poly[i],poly[(i+1)%poly.length],p);
      if(side>1e-4)positive=true;if(side<-1e-4)negative=true;
    }
    return poly.length>=3&&!(positive&&negative);
  }
  function footprint(m){
    const corners=[[0,0],[m.patchWidth-1,0],[m.patchWidth-1,m.patchHeight-1],[0,m.patchHeight-1]].map(([x,y])=>point(m.matrix,x,y)),r=bounds(corners);
    const x=(m.patchWidth-1)/2,y=(m.patchHeight-1)/2,c=point(m.matrix,x,y),u=point(m.matrix,x+1,y),v=point(m.matrix,x,y+1);
    const pitch=Math.sqrt(Math.hypot(u.x-c.x,u.y-c.y)*Math.hypot(v.x-c.x,v.y-c.y));
    const spanX=Math.max(24,r.right-r.x),spanY=Math.max(24,r.bottom-r.y);
    return {spanX,spanY,supportX:spanX,supportY:spanY,basis:[u.x-c.x,u.y-c.y,v.x-c.x,v.y-c.y],pitch,
      nominal:2**Math.max(0,Math.round(Math.log2(pitch)))};
  }
  function plan(known,width,height,stage=0){
    if(!known.length)return {guided:false,directional:false,targets:[],anchors:0};
    const layout=root.PixelStow.getVisualMarkerLayout(known[0]);
    let proposals=[];
    try{proposals=root.MarkerTrackerGeometry.predict(known,layout);}catch{/* Topology still constrains an unstable plane fit. */}
    const observed=known.map(m=>({marker:m,id:m.id,centre:centre(m),unit:unit(m.id),hint:footprint(m)}));
    const meanHint={spanX:observed.reduce((s,p)=>s+p.hint.spanX,0)/observed.length,
      spanY:observed.reduce((s,p)=>s+p.hint.spanY,0)/observed.length,
      supportX:Math.max(...observed.map(p=>p.hint.spanX)),supportY:Math.max(...observed.map(p=>p.hint.spanY)),
      nominal:observed.map(p=>p.hint.nominal).sort((a,b)=>a-b)[Math.floor(observed.length/2)]};
    const targets=[];
    // A non-mirrored or mirrored capture preserves a consistent local winding.
    const winding=Math.sign(known.reduce((sum,m)=>{
      const x=(m.patchWidth-1)/2,y=(m.patchHeight-1)/2,c=point(m.matrix,x,y),u=point(m.matrix,x+1,y),v=point(m.matrix,x,y+1);
      return sum+cross(c,u,v);
    },0))||1;
    for(const id of ids.filter(id=>!known.some(m=>m.id===id))){
      let feasible=[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}];
      for(let i=0;i<observed.length;i++)for(let j=i+1;j<observed.length;j++){
        const a=observed[i],b=observed[j],expected=cross(a.unit,b.unit,unit(id));
        if(Math.abs(expected)<1e-6)continue;
        const third=observed.find(p=>p!==a&&p!==b&&Math.abs(cross(a.unit,b.unit,p.unit))>1e-6);
        const side=third?Math.sign(cross(a.centre,b.centre,third.centre)*expected/cross(a.unit,b.unit,third.unit)):winding*Math.sign(expected);
        const dx=b.centre.x-a.centre.x,dy=b.centre.y-a.centre.y,length=Math.hypot(dx,dy);
        if(!side||length<1)continue;
        // Other corners cannot lie on an already occupied row/column. Leave
        // physical patch clearance from that line, including with only two IDs.
        const aligned=a.unit.x===b.unit.x||a.unit.y===b.unit.y;
        const across=observed.map(p=>{
          const m=p.marker,values=[[0,0],[m.patchWidth-1,0],[m.patchWidth-1,m.patchHeight-1],[0,m.patchHeight-1]]
            .map(([x,y])=>{const q=point(m.matrix,x,y);return(-dy*q.x+dx*q.y)/length;});
          return Math.max(...values)-Math.min(...values);
        });
        const clearance=Math.min(Math.min(...across)*(aligned?0.6:0.2),length*.15);
        feasible=clip(feasible,-side*dy/length,side*dx/length,side*(dy*a.centre.x-dx*a.centre.y)/length-clearance);
      }
      if(area(feasible)<4)continue;
      const proposal=proposals.find(p=>p.id===id);
      let polygon=feasible,hint=meanHint;
      if(proposal){
        hint=footprint(proposal);hint.supportX=Math.max(hint.supportX,meanHint.supportX);hint.supportY=Math.max(hint.supportY,meanHint.supportY);
        if(stage<2||known.length===1){
          const r=bounds(proposal.corners),p=centre(proposal),distance=Math.min(...observed.map(m=>Math.hypot(p.x-m.centre.x,p.y-m.centre.y)));
          const margin=proposal.span*(known.length>=3?(stage?0.95:0.45):(stage?2:1))+proposal.error*4+distance*(known.length>=3?0.025:0.12);
          const narrow=rectangle(feasible,{x:r.x-margin,y:r.y-margin,right:r.right+margin,bottom:r.bottom+margin});
          // Never trust an extrapolated pose that contradicts the ID topology.
          if(contains(feasible,p)&&area(narrow)>=4)polygon=narrow;
          else if(known.length===1)continue;
        }
      }else if(known.length===1)continue;
      targets.push({id,polygon,bounds:bounds(polygon),hint,proposal});
    }
    // One patch gives direction, scale and encoded dimensions, but its distant
    // predictions remain a priority hint. Two/three IDs also supply hard culls.
    return {guided:known.length>=2,directional:true,targets,anchors:known.length,stage};
  }
  function restrict(node,guidance){
    if(!guidance.guided)return node;
    const hits=guidance.targets.filter(t=>area(rectangle(t.polygon,{x:node.x,y:node.y,right:node.x+node.w,bottom:node.y+node.h}))>1e-4);
    if(!hits.length)return null;
    const hint={spanX:Math.max(...hits.map(t=>t.hint.spanX)),spanY:Math.max(...hits.map(t=>t.hint.spanY)),nominal:Math.max(...hits.map(t=>t.hint.nominal)),
      supportX:Math.max(node.hint?.supportX||node.hint?.spanX||0,...hits.map(t=>t.hint.supportX||t.hint.spanX)),
      supportY:Math.max(node.hint?.supportY||node.hint?.spanY||0,...hits.map(t=>t.hint.supportY||t.hint.spanY))};
    return {...node,hint,allowedIds:hits.map(t=>t.id),polygons:hits.map(t=>t.polygon),limit:bounds(hits.flatMap(t=>t.polygon))};
  }
  function seeds(rootNode,guidance,partition,split){
    let excluded=0,bypassed=0;
    const nodes=[];
    function descend(node){
      const limited=restrict(node,guidance);
      if(!limited){excluded++;return;}
      const r=limited.limit,hint=limited.hint;
      const tight=limited.w<=Math.max(128,(r.right-r.x)*1.25,hint.spanX*2)&&limited.h<=Math.max(128,(r.bottom-r.y)*1.25,hint.spanY*2);
      const kids=tight?[]:partition(limited,hint,split);
      if(!kids.length){nodes.push(limited);return;}
      bypassed++;for(const child of kids)descend(child);
    }
    if(guidance.guided)descend(rootNode);else nodes.push(rootNode);
    return {nodes,excluded,bypassed};
  }
  const permits=(marker,guidance)=>!guidance.guided||guidance.targets.some(t=>t.id===marker.id&&contains(t.polygon,centre(marker)));
  const clipRegions=(polygons,region)=>polygons.map(poly=>rectangle(poly,{x:region.x,y:region.y,right:region.x+region.w,bottom:region.y+region.h})).filter(poly=>area(poly)>1e-4);
  function hull(points){
    points=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
    const lower=[],upper=[];
    for(const p of points){while(lower.length>1&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p);}
    for(let i=points.length-1;i>=0;i--){const p=points[i];while(upper.length>1&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}
    return lower.slice(0,-1).concat(upper.slice(0,-1));
  }
  function contextRegions(polygons,padX,padY,width,height){
    // These polygons bound legal CENTRES. Expand them before clipping pixels so
    // a patch centred on their boundary retains its surrounding image samples.
    return polygons.map(poly=>rectangle(hull(poly.flatMap(p=>[-padY,padY].flatMap(dy=>[-padX,padX].map(dx=>({x:p.x+dx,y:p.y+dy}))))),
      {x:0,y:0,right:width,bottom:height})).filter(poly=>area(poly)>1e-4);
  }
  const regionBounds=polygons=>bounds(polygons.flat());
  root.MarkerTrackerSearchPlan={plan,restrict,seeds,permits,clipRegions,contextRegions,regionBounds,footprint};
})(typeof window!=='undefined'?window:self);
