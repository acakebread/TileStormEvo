// Lab geometry: verified patch poses constrain the other corners of one picture.
(function(root){
  'use strict';
  const multiply=(a,b)=>Array.from({length:9},(_,i)=>{const r=Math.floor(i/3),c=i%3;return a[r*3]*b[c]+a[r*3+1]*b[c+3]+a[r*3+2]*b[c+6];});
  const point=(h,x,y)=>{const z=h[6]*x+h[7]*y+h[8];return{x:(h[0]*x+h[1]*y+h[2])/z,y:(h[3]*x+h[4]*y+h[5])/z};};
  function solve(a,b){
    a=a.slice();b=b.slice();const n=b.length;
    for(let k=0;k<n;k++){
      let p=k;for(let j=k+1;j<n;j++)if(Math.abs(a[j*n+k])>Math.abs(a[p*n+k]))p=j;
      if(Math.abs(a[p*n+k])<1e-9)return null;
      for(let j=k;j<n;j++)[a[k*n+j],a[p*n+j]]=[a[p*n+j],a[k*n+j]];[b[k],b[p]]=[b[p],b[k]];
      const d=a[k*n+k];for(let j=k;j<n;j++)a[k*n+j]/=d;b[k]/=d;
      for(let i=0;i<n;i++)if(i!==k){const f=a[i*n+k];for(let j=k;j<n;j++)a[i*n+j]-=f*a[k*n+j];b[i]-=f*b[k];}
    }return b;
  }
  function predict(markers,layout){
    if(!markers.length||!layout?.length)return [];
    const seed=markers[0],w=seed.originalWidth,h=seed.originalHeight,pairs=[];
    for(const m of markers){
      const spot=layout.find(p=>p.id===m.id);if(!spot)continue;
      for(const [x,y] of [[0,0],[m.patchWidth-1,0],[m.patchWidth-1,m.patchHeight-1],[0,m.patchHeight-1]]){
        const q=point(m.matrix,x,y);pairs.push({x:(spot.x+x)/w,y:(spot.y+y)/h,u:q.x/w,v:q.y/h});
      }
    }
    let plane;
    if(markers.length===1){
      // Extrapolating the perspective terms of one tiny noisy patch is unstable.
      // Use its measured local axes until another verified corner constrains it.
      const m=seed,spot=layout.find(p=>p.id===m.id);if(!spot)return [];
      const x=(m.patchWidth-1)/2,y=(m.patchHeight-1)/2,c=point(m.matrix,x,y),a=point(m.matrix,x+1,y),b=point(m.matrix,x,y+1);
      plane=[a.x-c.x,b.x-c.x,c.x-(a.x-c.x)*(spot.x+x)-(b.x-c.x)*(spot.y+y),
        a.y-c.y,b.y-c.y,c.y-(a.y-c.y)*(spot.x+x)-(b.y-c.y)*(spot.y+y),0,0,1];
    }else{
      const a=new Float64Array(64),b=new Float64Array(8);
      for(const {x,y,u,v} of pairs)for(const [row,value] of [[[x,y,1,0,0,0,-u*x,-u*y],u],[[0,0,0,x,y,1,-v*x,-v*y],v]])
        for(let i=0;i<8;i++){b[i]+=row[i]*value;for(let j=0;j<8;j++)a[i*8+j]+=row[i]*row[j];}
      const fit=solve(a,b);if(!fit)return [];
      plane=multiply([w,0,0,0,h,0,0,0,1],multiply([...fit,1],[1/w,0,0,0,1/h,0,0,0,1]));
    }
    const depths=[[0,0],[w,0],[w,h],[0,h]].map(([x,y])=>plane[6]*x+plane[7]*y+plane[8]);
    if(Math.min(...depths)*Math.max(...depths)<=0||Math.max(...depths.map(Math.abs))/Math.min(...depths.map(Math.abs))>16)return [];
    const error=Math.sqrt(pairs.reduce((sum,p)=>{const q=point(plane,p.x*w,p.y*h);return sum+(q.x-p.u*w)**2+(q.y-p.v*h)**2;},0)/pairs.length);
    if(!Number.isFinite(error))return [];
    return layout.map(spot=>{
      const matrix=multiply(plane,[1,0,spot.x,0,1,spot.y,0,0,1]);
      const corners=[[0,0],[spot.patchWidth-1,0],[spot.patchWidth-1,spot.patchHeight-1],[0,spot.patchHeight-1]].map(([x,y])=>point(matrix,x,y));
      const span=Math.max(...corners.map((p,i)=>Math.hypot(p.x-corners[(i+1)%4].x,p.y-corners[(i+1)%4].y)));
      return {...seed,...spot,matrix,corners,span,error};
    }).filter(p=>p.corners.every(q=>Number.isFinite(q.x+q.y))&&p.span>4&&error<p.span*.25);
  }
  root.MarkerTrackerGeometry={multiply,point,predict};
})(typeof window!=='undefined'?window:self);
