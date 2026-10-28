// Copyright 2026 massivehadron.com ltd.

// Experimental carrier-3 geometry discovery. No canvas, DOM or server dependency.
// Pixel-centre coordinates are used throughout; payload validation lives in the codec.
(function (root) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const centre = (adapter) => ({ x: (adapter.patchWidth - 1) / 2, y: (adapter.patchHeight - 1) / 2 });

  function point(h, x, y) {
    const d = h[6] * x + h[7] * y + h[8];
    return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
  }

  function multiply(a, b) {
    const out = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    return out;
  }

  function invert(h) {
    const [a, b, c, d, e, f, g, j, k] = h;
    const out = [e * k - f * j, c * j - b * k, b * f - c * e,
      f * g - d * k, a * k - c * g, c * d - a * f,
      d * j - e * g, b * g - a * j, a * e - b * d];
    const determinant = a * out[0] + b * out[3] + c * out[6];
    if (Math.abs(determinant) < 1e-12) throw new Error("The recovered transform is singular.");
    return out.map((value) => value / determinant);
  }

  function patchMatrix(h, patch) {
    return multiply(h, [1, 0, patch.x, 0, 1, patch.y, 0, 0, 1]);
  }

  function offsetMatrix(matrix, dx, dy) {
    const out = matrix.slice();
    for (let i = 0; i < 3; i++) { out[i] += dx * out[i + 6]; out[i + 3] += dy * out[i + 6]; }
    return out;
  }

  function basisMatrix(b, adapter, perspective = [0, 0]) {
    const c = centre(adapter);
    const [g, h] = perspective, d = 1 - g * c.x - h * c.y;
    return [b[2] + b[0] * g, b[4] + b[0] * h, b[0] * d - b[2] * c.x - b[4] * c.y,
      b[3] + b[1] * g, b[5] + b[1] * h, b[1] * d - b[3] * c.x - b[5] * c.y, g, h, d];
  }

  function matrixBasis(h, adapter) {
    const c = centre(adapter), p = point(h, c.x, c.y);
    const d = h[6] * c.x + h[7] * c.y + h[8];
    return [p.x, p.y, (h[0] - p.x * h[6]) / d, (h[3] - p.y * h[6]) / d,
      (h[1] - p.x * h[7]) / d, (h[4] - p.y * h[7]) / d];
  }

  function reasonableBasis(b) {
    const u = Math.hypot(b[2], b[3]), v = Math.hypot(b[4], b[5]);
    return u >= 0.4 && v >= 0.4 && u <= 2.6 && v <= 2.6 &&
      (b[2] * b[5] - b[3] * b[4]) / (u * v) > 0.35;
  }

  function bilinear(values, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const x1 = Math.min(w - 1, ix + 1), y1 = Math.min(h - 1, iy + 1);
    return values[ix + iy * w] * (1 - fx) * (1 - fy) + values[x1 + iy * w] * fx * (1 - fy) +
      values[ix + y1 * w] * (1 - fx) * fy + values[x1 + y1 * w] * fx * fy;
  }

  function keepPeak(peaks, candidate, maximum = 24, separation = 5) {
    const near = peaks.findIndex((other) => other.id === candidate.id && Math.hypot(candidate.x - other.x, candidate.y - other.y) < separation);
    if (near >= 0) {
      if (peaks[near].score >= candidate.score) return;
      peaks.splice(near, 1);
    }
    if (peaks.length >= maximum && candidate.score <= peaks[peaks.length - 1].score) return;
    const index = peaks.findIndex((other) => other.score < candidate.score);
    peaks.splice(index < 0 ? peaks.length : index, 0, candidate);
    if (peaks.length > maximum) peaks.length = maximum;
  }

  function check(options) {
    if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    if (options.deadline && Date.now() > options.deadline) {
      const error = new Error("This geometry pass reached its search time limit. No exhaustive angle sweep was run.");
      error.name = "SearchLimit"; throw error;
    }
  }

  function borderSlice(index, width, height, band = 0.2) {
    // Eight pieces of the readable border. Opposite corners come first, then
    // the opposite edge middles. One piece is one time slice: its mip chain
    // runs from the smallest image upward inside that same slice.
    const names = ["top left", "bottom right", "top right", "bottom left", "top", "bottom", "left", "right"];
    const which = ((index % 8) + 8) % 8;
    const xL = width * band, xR = width * (1 - band), yT = height * band, yB = height * (1 - band);
    const boxes = [
      [0, 0, xL, yT], [xR, yB, width, height], [xR, 0, width, yT], [0, yB, xL, height],
      [xL, 0, xR, yT], [xL, yB, xR, height], [0, yT, xL, yB], [xR, yT, width, yB]
    ];
    const [x0, y0, x1, y1] = boxes[which];
    return { index: which, name: names[which], divisors: [16, 8, 4, 2, 1], region: { x0, y0, x1, y1 } };
  }

  function inSearchRegion(x, y, region) {
    return !region || (x >= region.x0 && y >= region.y0 && x < region.x1 && y < region.y1);
  }

  async function responseField(luma, width, height, basis, adapter, options) {
    // Preserve the versioned locator wavelet. This is a response field, not a
    // reduced photograph: sample original pixels before reducing search positions.
    const step = Math.max(1, Math.ceil(Math.sqrt(width * height / 6000000)));
    const w = Math.ceil(width / step), h = Math.ceil(height / step);
    const values = new Float32Array(w * h);
    const taps = [], spacing = adapter.sampleStep ?? 1.5, offset = adapter.sampleOffset ?? 0.5;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      taps.push({ x: basis[0] * (spacing * x + offset) + basis[2] * (spacing * y + offset),
        y: basis[1] * (spacing * x + offset) + basis[3] * (spacing * y + offset), weight: adapter.shape[x + y * 4] });
    }
    const quick = options.camera === true && width * height <= 512 * 512;
    const band = options.edgeBand || 0;
    const reach = Math.max(0, ...taps.map((tap) => Math.max(Math.abs(tap.x), Math.abs(tap.y)))) + step;
    const marginX = width * band + reach, marginY = height * band + reach;
    // The centre of a camera frame cannot hold a readable corner. Skip it.
    const interior = (px, py) => band && px >= marginX && px <= width - marginX && py >= marginY && py <= height - marginY;
    const region = options.region;
    const yStart = region ? Math.max(0, Math.floor((region.y0 - reach) / step)) : 0;
    const yEnd = region ? Math.min(h, Math.ceil((region.y1 + reach) / step)) : h;
    const xStart = region ? Math.max(0, Math.floor((region.x0 - reach) / step)) : 0;
    const xEnd = region ? Math.min(w, Math.ceil((region.x1 + reach) / step)) : w;
    for (let y = yStart; y < yEnd; y++) {
      if ((y & 31) === 31) { check(options); if (!quick) await pause(); }
      for (let x = xStart; x < xEnd; x++) {
        if (interior(x * step, y * step)) continue;
        let sum = 0, squares = 0, projection = 0;
        for (const tap of taps) {
          const value = bilinear(luma, width, height, x * step + tap.x, y * step + tap.y);
          sum += value; squares += value * value; projection += value * tap.weight;
        }
        values[x + y * w] = projection / Math.sqrt(400 + Math.max(0, squares - sum * sum / 16));
      }
    }
    return { values, width: w, height: h, step };
  }

  async function globalCandidates(luma, width, height, basis, adapter, options) {
    const accelerated=options.searchCompute?.candidates(luma,width,height,basis,adapter,options);
    if(accelerated){
      const peaks=adapter.ids.map(()=>[]);
      for(let y=0;y<accelerated.height;y++)for(let x=0;x<accelerated.width;x++){
        const px=x*accelerated.step,py=y*accelerated.step;
        if(options.edgeBand&&!inEdgeBand(px,py,width,height,options.edgeBand))continue;
        for(let id=0;id<adapter.ids.length;id++){
          const score=accelerated.values[(x+y*accelerated.width)*4+id];if(!(score>0))continue;
          keepPeak(peaks[id],{id:adapter.ids[id],x:px,y:py,score,matrix:[basis[0],basis[2],px,basis[1],basis[3],py,0,0,1]});
        }
      }
      check(options);return peaks.flat().sort((a,b)=>b.score-a.score);
    }
    const field = await responseField(luma, width, height, basis, adapter, options);
    const points = adapter.pilots[0].points.map((p) => ({ x: (basis[0] * p.x + basis[2] * p.y) / field.step,
      y: (basis[1] * p.x + basis[3] * p.y) / field.step }));
    const scores = new Float64Array(24), peaks = adapter.ids.map(() => []);
    const scanStep = options.mode === "padding" ? 1 : 2;
    const region = options.region;
    const yStart = region ? Math.max(0, Math.floor(region.y0 / field.step / scanStep) * scanStep) : 0;
    const xStart = region ? Math.max(0, Math.floor(region.x0 / field.step / scanStep) * scanStep) : 0;
    const yEnd = region ? Math.min(field.height, Math.ceil(region.y1 / field.step)) : field.height;
    const xEnd = region ? Math.min(field.width, Math.ceil(region.x1 / field.step)) : field.width;
    for (let y = yStart; y < yEnd; y += scanStep) {
      if ((y & 31) === 0) { check(options); if (!(options.camera && width * height <= 512 * 512)) await pause(); }
      for (let x = xStart; x < xEnd; x += scanStep) {
        const px = x * field.step, py = y * field.step;
        if (region ? !inSearchRegion(px, py, region) : options.edgeBand && !inEdgeBand(px, py, width, height, options.edgeBand)) continue;
        let agreement = 0, energy = 0;
        for (let slot = 0; slot < 12; slot++) {
          const p = points[slot];
          scores[slot] = bilinear(field.values, field.width, field.height, x + p.x, y + p.y);
          agreement += scores[slot] * adapter.pilots[0].points[slot].sign;
          energy += Math.abs(scores[slot]);
        }
        if (energy < 12 * 8 || agreement / energy < 0.45) continue;
        for (let slot = 12; slot < 24; slot++) {
          const p = points[slot];
          scores[slot] = bilinear(field.values, field.width, field.height, x + p.x, y + p.y);
          energy += Math.abs(scores[slot]);
        }
        if (energy < 24 * 8) continue;
        for (let id = 0; id < adapter.ids.length; id++) {
          let combined = agreement;
          for (let slot = 12; slot < 24; slot++) combined += scores[slot] * adapter.pilots[id].points[slot].sign;
          const quality = combined / energy;
          if (quality < 0.58) continue;
          keepPeak(peaks[id], { id: adapter.ids[id], x: x * field.step, y: y * field.step,
            score: quality * Math.min(1, energy / (24 * 12)), matrix: [basis[0], basis[2], x * field.step, basis[1], basis[3], y * field.step, 0, 0, 1] });
        }
      }
    }
    return peaks.flat().sort((a, b) => b.score - a.score);
  }

  async function refine(candidate, adapter, dimensions, options, wide = false) {
    // Fit a small patch locally before attempting a global affine/projective fit.
    const c = centre(adapter), h = candidate.matrix, d = h[6] * c.x + h[7] * c.y + h[8];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
    // Keep any projective curvature supplied by the current plane estimate.
    // The centre and both local derivatives remain independently adjustable.
    const perspective = options.mode === "perspective" ? [h[6] / d, h[7] / d] : [0, 0];
    const toMatrix = (basis) => basisMatrix(basis, adapter, perspective);
    let basis = matrixBasis(candidate.matrix, adapter);
    let score = adapter.quality(toMatrix(basis), candidate.id, dimensions);
    const initial = basis.slice();
    // Discovery only accepts a marker near one reduced pixel. A lock on the
    // camera is already at the real on-screen size, often several pixels, and
    // the next frame has to be allowed to move at that size.
    const followScale = Math.max(Math.hypot(initial[2], initial[3]), Math.hypot(initial[4], initial[5])) || 1;
    const nearLock = (b) => {
      const u = Math.hypot(b[2], b[3]), v = Math.hypot(b[4], b[5]);
      if (!(u > 0 && v > 0 && (b[2] * b[5] - b[3] * b[4]) / (u * v) > 0.35)) return false;
      if (!options.camera) return u >= 0.4 && v >= 0.4 && u <= 2.6 && v <= 2.6;
      const ru = Math.hypot(initial[2], initial[3]) || 1, rv = Math.hypot(initial[4], initial[5]) || 1;
      return u >= ru * 0.72 && u <= ru * 1.4 && v >= rv * 0.72 && v <= rv * 1.4;
    };
    if (wide) {
      // Multiple starting basins bridge the deliberately coarse angle/scale bank.
      for (const degrees of [0, -4, 4]) for (const scale of [1, 0.95, 1.05]) {
        const angle = degrees * Math.PI / 180, cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
        const b = initial.slice();
        b[2] = cos * initial[2] - sin * initial[3]; b[3] = sin * initial[2] + cos * initial[3];
        b[4] = cos * initial[4] - sin * initial[5]; b[5] = sin * initial[4] + cos * initial[5];
        if (!nearLock(b)) continue;
        const value = adapter.quality(toMatrix(b), candidate.id, dimensions);
        if (value > score) { score = value; basis = b; }
      }
    }
    const sizes = options.camera && followScale > 2.4
      ? [followScale * 0.45, followScale * 0.22, 1.5, 0.75, 0.35, 0.15, 0.06]
      : [1.5, 0.75, 0.35, 0.15, 0.06];
    for (const size of sizes) {
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (let axis = 0; axis < (options.mode === "padding" ? 2 : 6); axis++) {
          const delta = axis < 2 ? size : size / Math.max(adapter.patchWidth, adapter.patchHeight) * 2;
          let best = basis, bestScore = score;
          for (const sign of [-1, 1]) {
            const b = basis.slice(); b[axis] += delta * sign;
            if (!nearLock(b)) continue;
            const value = adapter.quality(toMatrix(b), candidate.id, dimensions);
            if (value > bestScore) { bestScore = value; best = b; }
          }
          if (best !== basis) { basis = best; score = bestScore; changed = true; }
        }
        if (!changed) break;
      }
      check(options); if (!options.continuousWorker) await pause();
    }
    const matrix = toMatrix(basis);
    if (options.mode === "padding") {
      // Native padded pixels have an integer translation, even when the response
      // field used every second search position on a large input.
      matrix[2] = Math.round(matrix[2]); matrix[5] = Math.round(matrix[5]);
    }
    const accepted = (read) => read && (!dimensions || (read.originalWidth === dimensions.originalWidth && read.originalHeight === dimensions.originalHeight));
    const read = dimensions ? adapter.confirm(matrix, candidate.id, dimensions) : adapter.read(matrix, candidate.id);
    if (accepted(read)) return { ...read, localized: true };
    // A small move can raise the soft score while breaking the header check.
    // The sample that already read is the lock; keep it.
    if (dimensions) {
      const kept = adapter.confirm(candidate.matrix, candidate.id, dimensions);
      if (accepted(kept)) return { ...kept, matrix: kept.matrix || candidate.matrix, localized: true };
    }
    return null;
  }

  function convexHull(points) {
    points.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const lower = [], upper = [];
    for (const p of points) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    while (hull.length > 4) {
      let index = 0, area = Infinity;
      for (let i = 0; i < hull.length; i++) {
        const value = Math.abs(cross(hull[(i + hull.length - 1) % hull.length], hull[i], hull[(i + 1) % hull.length]));
        if (value < area) { area = value; index = i; }
      }
      hull.splice(index, 1);
    }
    return hull;
  }

  async function paddingQuads(pixels, width, height, options) {
    // Fast proposal for visible padding, including the white/orange examples.
    // It only proposes geometry: it cannot establish that the picture is encoded.
    const colours = [], quads = [];
    let lastYield=Date.now();
    const cooperate=async()=>{check(options);if(Date.now()-lastYield>=16){await pause();lastYield=Date.now();}};
    const rgb = (x, y) => { const i = (Math.round(x) + Math.round(y) * width) * 4; return [pixels[i], pixels[i + 1], pixels[i + 2]]; };
    const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const edge = [];
    for (let i = 0; i < 16; i++) {
      const x = i * (width - 1) / 15, y = i * (height - 1) / 15;
      edge.push(rgb(x, 0), rgb(x, height - 1), rgb(0, y), rgb(width - 1, y));
    }
    for (const colour of edge) {
      if (colours.some((c) => distance(c, colour) < 20)) continue;
      if (edge.filter((c) => distance(c, colour) < 20).length >= 24) colours.push(colour);
    }
    const step = Math.max(1, Math.ceil(Math.max(width, height) / 640)), w = Math.ceil(width / step), h = Math.ceil(height / step);
    for (const colour of colours.slice(0, 2)) for (const tolerance of [22, 45]) {
      options.onProgress?.("Checking visible padding for an image outline…");
      const mask = new Uint8Array(w * h), visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
      for (let y = 0; y < h; y++) {
        if ((y & 31) === 0) await cooperate();
        for (let x = 0; x < w; x++) mask[x + y * w] = distance(rgb(Math.min(width - 1, x * step), Math.min(height - 1, y * step)), colour) > tolerance ? 1 : 0;
      }
      let largest = 0, boundary = [];
      for (let start = 0; start < mask.length; start++) {
        if ((start & 8191) === 0) await cooperate();
        if (!mask[start] || visited[start]) continue;
        let head = 0, tail = 1; queue[0] = start; visited[start] = 1;
        const outline = [];
        while (head < tail) {
          if ((head & 8191) === 8191) await cooperate();
          const i = queue[head++], x = i % w, y = Math.floor(i / w);
          let onEdge = false;
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nx = x + dx, ny = y + dy, n = nx + ny * w;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[n]) { onEdge = true; continue; }
            if (!visited[n]) { visited[n] = 1; queue[tail++] = n; }
          }
          if (onEdge) outline.push({ x: Math.min(width - 1, x * step), y: Math.min(height - 1, y * step) });
        }
        if (tail > largest) { largest = tail; boundary = outline; }
      }
      if (largest < mask.length * 0.06 || largest > mask.length * 0.995 || boundary.length < 4) continue;
      const hull = convexHull(boundary);
      if (hull.length === 4 && !quads.some((q) => q.every((p, i) => Math.hypot(p.x - hull[i].x, p.y - hull[i].y) < step * 2))) quads.push(hull);
    }
    return quads;
  }

  function quadFit(corners, width, height) {
    return fitPoints([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
      .map(([x, y], i) => ({ source: { x, y }, target: corners[i] })), true);
  }

  async function proposeOutlines(pixels, width, height, requested = {}) {
    // Geometry proposals only. A visible rectangle cannot confirm a carrier.
    const options = { ...requested, deadline: Math.min(requested.deadline || Infinity, Date.now() + (requested.maxMilliseconds || 350)) };
    const quads = await paddingQuads(pixels, width, height, options);
    const sample = (x, y, channel) => pixels[(Math.max(0, Math.min(width - 1, Math.round(x))) +
      Math.max(0, Math.min(height - 1, Math.round(y))) * width) * 4 + channel];
    const radius = Math.max(3, 2 * Math.ceil(Math.max(width, height) / 640));
    const fit = (points) => {
      if (points.length < 8) return null;
      const cx = points.reduce((s,p) => s+p.x,0)/points.length, cy = points.reduce((s,p) => s+p.y,0)/points.length;
      let xx=0,xy=0,yy=0;
      for (const p of points) { const x=p.x-cx,y=p.y-cy;xx+=x*x;xy+=x*y;yy+=y*y; }
      const angle=.5*Math.atan2(2*xy,xx-yy),nx=-Math.sin(angle),ny=Math.cos(angle);
      return {nx,ny,d:nx*cx+ny*cy};
    };
    return quads.map((quad) => {
      const lines=quad.map((a,index) => {
        const b=quad[(index+1)%4],length=Math.hypot(b.x-a.x,b.y-a.y),nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length,points=[];
        for(let i=0;i<40;i++) {
          const t=.08+.84*i/39,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
          let best=null;
          for(let offset=-radius;offset<=radius;offset+=.5) {
            const px=x+nx*offset,py=y+ny*offset;
            let energy=0;
            for(let channel=0;channel<3;channel++)energy+=Math.abs(sample(px+nx,py+ny,channel)-sample(px-nx,py-ny,channel));
            if(!best||energy>best.energy)best={x:px,y:py,energy};
          }
          if(best.energy>24)points.push(best);
        }
        let line=fit(points);
        for(let pass=0;pass<2&&line;pass++)line=fit(points.filter(p=>Math.abs(line.nx*p.x+line.ny*p.y-line.d)<1.75));
        return line;
      });
      if(lines.some(line=>!line))return quad;
      const refined=lines.map((b,index) => {
        const a=lines[(index+3)%4],d=a.nx*b.ny-a.ny*b.nx;
        return Math.abs(d)<.1?null:{x:(a.d*b.ny-a.ny*b.d)/d,y:(a.nx*b.d-a.d*b.nx)/d};
      });
      return refined.some((point,i)=>!point||Math.hypot(point.x-quad[i].x,point.y-quad[i].y)>radius*4)?quad:refined;
    });
  }

  async function seedFromQuads(quads, signature, adapters, options) {
    const scales = [[1, 1]], proposals = [];
    for (const basis of signature.bases || []) {
      const s = [Math.hypot(basis[0], basis[1]), Math.hypot(basis[2], basis[3])];
      if (!scales.some((v) => Math.abs(v[0] - s[0]) + Math.abs(v[1] - s[1]) < 0.04)) scales.push(s);
    }
    if (!options.pilotFirst) for (const scale of [0.95, 1.05, 0.75, 1.25, 0.5, 2]) scales.push([scale, scale]);
    for (const quad of quads) for (let turn = 0; turn < 4; turn++) {
      const corners = quad.slice(turn).concat(quad.slice(0, turn));
      const sideX = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
      const sideY = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
      for (const [sx, sy] of scales) for (const adapter of adapters) {
        const ow = Math.round(sideX / sx) + 1, oh = Math.round(sideY / sy) + 1;
        const layout = adapter.layout(ow, oh), fit = quadFit(corners, ow, oh);
        if (!layout || !fit) continue;
        options.onProgress?.("Checking markers near the detected outline (orientation " + (turn + 1) + "/4)…");
        for (const id of [0, 2, 6, 8]) {
          check(options);
          const patch = layout.find((p) => p.id === id), matrix = patchMatrix(fit, patch);
          for (const dy of [0, -1.5, 1.5]) for (const dx of [0, -1.5, 1.5]) {
            const trial = offsetMatrix(matrix, dx, dy), score = adapter.quality(trial, id);
            options.pilotQuality = Math.max(options.pilotQuality || 0, score);
            if (options.pilotFirst && score > .6) {
              const direct = adapter.read(trial, id);
              if (direct) return { ...direct, initialMatrix: quadFit(corners, direct.originalWidth, direct.originalHeight) };
            }
            if (score > 0.2) proposals.push({ matrix: trial, id, score, corners, adapter });
          }
        }
        await pause();
      }
    }
    proposals.sort((a, b) => b.score - a.score);
    for (const proposal of proposals.slice(0, 24)) {
      check(options);
      const adapter = proposal.adapter;
      const direct = adapter.read(proposal.matrix, proposal.id);
      if (direct) return { ...direct, initialMatrix: quadFit(proposal.corners, direct.originalWidth, direct.originalHeight) };
    }
    for (const proposal of proposals.slice(0, 24)) {
      check(options);
      const adapter = proposal.adapter;
      const seed = await refine(proposal, adapter, null, options, true);
      if (seed) return { ...seed, initialMatrix: quadFit(proposal.corners, seed.originalWidth, seed.originalHeight) };
    }
    return null;
  }

  async function seedSearch(pixels, luma, width, height, adapters, options, signature) {
    if (options.pilotFirst) {
      const guideCorners=options.scaleGuide?.corners;
      const quads=guideCorners?.length===4&&guideCorners.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))?[guideCorners]:[];
      quads.push([{x:0,y:0},{x:width-1,y:0},{x:width-1,y:height-1},{x:0,y:height-1}]);
      const seed = await seedFromQuads(quads,signature,adapters,options);
      if (seed) return seed;
    }
    if (options.mode !== "padding" && !options.frequencyOnly) {
      const quads = options.corners?.length === 4 ? [options.corners] : await paddingQuads(pixels, width, height, options);
      const seed = await seedFromQuads(quads, signature, adapters, options);
      if (seed) return seed;
    }
    const banks = options.mode === "padding" ? [[1, 0, 0, 1]] : signature.bases.slice(0, options.frequencyBankLimit || 12);
    if (options.forceSearch && !banks.length) banks.push([1, 0, 0, 1]);
    // A camera frame has about two seconds. The four turns of the strongest
    // lattice must all get a header check before any of them is polished:
    // polishing a wrong turn was consuming the whole frame and the readable
    // turn was never reached.
    const cameraHunt = options.camera === true && options.mode !== "padding";
    // The lab compares wavelength families at a node before descending. Its
    // explicit bank limit checks every supplied family; ordinary camera calls
    // retain the original four-turn allowance.
    const bankLimit = cameraHunt ? Math.min(options.frequencyBankLimit || 4, banks.length) : banks.length;
    const later = [];
    for (let bank = 0; bank < bankLimit; bank++) {
      check(options);
      const basis = banks[bank];
      options.onProgress?.("Locating patches using the frequency estimate (" + (bank + 1) + "/" + bankLimit + ")…");
      const peaks = [];
      for (const adapter of adapters) {
        const candidates = await globalCandidates(luma, width, height, basis, adapter, options);
        for (const peak of candidates) {
          options.pilotQuality = Math.max(options.pilotQuality || 0, peak.score);
          peaks.push({ ...peak, adapter });
        }
      }
      peaks.sort((a, b) => b.score - a.score);
      // Both versions get cheap header checks before any expensive local fit.
      // A new profile must not delay discovery of the previous carrier behind
      // dozens of plausible but invalid patches of the other frequency.
      for (const peak of (cameraHunt ? peaks.slice(0, 8) : peaks)) {
        const adapter = peak.adapter;
        const direct = adapter.read(peak.matrix, peak.id);
        if (direct) return direct;
      }
      if (cameraHunt) { later.push(...peaks.slice(0, 4)); continue; }
      for (const peak of peaks.slice(0, 32)) {
        const adapter = peak.adapter;
        const refined = await refine(peak, adapter, null, options, options.mode !== "padding");
        if (refined) return refined;
      }
    }
    if (cameraHunt) {
      later.sort((a, b) => b.score - a.score);
      for (const peak of later.slice(0, options.seedRefinements ?? 8)) {
        check(options);
        const refined = await refine(peak, peak.adapter, null, options, false);
        if (refined) return refined;
      }
    }
    return null;
  }

  function solve(rows, values, unknowns) {
    const matrix = Array.from({ length: unknowns }, () => new Float64Array(unknowns + 1));
    for (let i = 0; i < rows.length; i++) for (let a = 0; a < unknowns; a++) {
      matrix[a][unknowns] += rows[i][a] * values[i];
      for (let b = 0; b < unknowns; b++) matrix[a][b] += rows[i][a] * rows[i][b];
    }
    for (let c = 0; c < unknowns; c++) {
      let pivot = c;
      for (let r = c + 1; r < unknowns; r++) if (Math.abs(matrix[r][c]) > Math.abs(matrix[pivot][c])) pivot = r;
      if (Math.abs(matrix[pivot][c]) < 1e-10) return null;
      [matrix[pivot], matrix[c]] = [matrix[c], matrix[pivot]];
      const divisor = matrix[c][c];
      for (let k = c; k <= unknowns; k++) matrix[c][k] /= divisor;
      for (let r = 0; r < unknowns; r++) if (r !== c) {
        const factor = matrix[r][c];
        for (let k = c; k <= unknowns; k++) matrix[r][k] -= factor * matrix[c][k];
      }
    }
    return matrix.map((row) => row[unknowns]);
  }

  function normalize(points) {
    const x = points.reduce((s, p) => s + p.x, 0) / points.length, y = points.reduce((s, p) => s + p.y, 0) / points.length;
    const radius = Math.sqrt(points.reduce((s, p) => s + (p.x - x) ** 2 + (p.y - y) ** 2, 0) / points.length);
    if (radius < 1e-6) return null;
    const scale = Math.SQRT2 / radius;
    const matrix = [scale, 0, -scale * x, 0, scale, -scale * y, 0, 0, 1];
    return { matrix, points: points.map((p) => point(matrix, p.x, p.y)) };
  }

  function fitPoints(pairs, projective) {
    if (pairs.length < (projective ? 4 : 3)) return null;
    const source = normalize(pairs.map((p) => p.source)), target = normalize(pairs.map((p) => p.target));
    if (!source || !target) return null;
    const rows = [], values = [];
    for (let i = 0; i < pairs.length; i++) {
      const { x, y } = source.points[i], { x: u, y: v } = target.points[i];
      const weight = Math.sqrt(pairs[i].weight || 1);
      rows.push((projective ? [x, y, 1, 0, 0, 0, -u * x, -u * y] : [x, y, 1, 0, 0, 0]).map((v) => v * weight)); values.push(u * weight);
      rows.push((projective ? [0, 0, 0, x, y, 1, -v * x, -v * y] : [0, 0, 0, x, y, 1]).map((v) => v * weight)); values.push(v * weight);
    }
    const fit = solve(rows, values, projective ? 8 : 6);
    if (!fit) return null;
    const h = fit.slice(0, 6).concat(projective ? fit.slice(6) : [0, 0], [1]);
    const matrix = multiply(invert(target.matrix), multiply(h, source.matrix));
    if (!Number.isFinite(matrix[8]) || Math.abs(matrix[8]) < 1e-10) return null;
    return matrix.map((v) => v / matrix[8]);
  }

  function subsets(items, size, start = 0, previous = [], output = []) {
    if (previous.length === size) { output.push(previous); return output; }
    for (let i = start; i <= items.length - (size - previous.length); i++) subsets(items, size, i + 1, previous.concat(items[i]), output);
    return output;
  }

  function centrePair(marker, layout, adapter) {
    const patch = layout.find((p) => p.id === marker.id), c = centre(adapter);
    // These interior points measure the locally fitted axes, not extra markers.
    // A prediction that merely passes a pattern threshold has no measured axes.
    const controls = marker.localized ? [[-c.x * 0.65, 0], [c.x * 0.65, 0], [0, -c.y * 0.65], [0, c.y * 0.65]]
      .map(([dx, dy]) => ({ source: { x: patch.x + c.x + dx, y: patch.y + c.y + dy },
        target: point(marker.matrix, c.x + dx, c.y + dy) })) : [];
    return { source: { x: patch.x + c.x, y: patch.y + c.y }, target: point(marker.matrix, c.x, c.y), marker, controls };
  }

  function separated(sample) {
    // Four centres cannot determine a homography if any three are collinear.
    // In particular, the three top patches plus the left midpoint are singular.
    for (const triple of subsets(sample, 3)) for (const side of ["source", "target"]) {
      const [a, b, c] = triple.map((p) => p[side]);
      const span = Math.max((a.x - b.x) ** 2 + (a.y - b.y) ** 2,
        (a.x - c.x) ** 2 + (a.y - c.y) ** 2, (b.x - c.x) ** 2 + (b.y - c.y) ** 2);
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      if (area <= span * 0.001) return false;
    }
    return true;
  }

  function controlPairs(pairs) {
    return pairs.flatMap((pair) => [{ source: pair.source, target: pair.target, weight: 4 }, ...pair.controls]);
  }

  function measurementError(matrix, pair) {
    const distance = (p) => {
      const mapped = point(matrix, p.source.x, p.source.y);
      return Math.hypot(mapped.x - p.target.x, mapped.y - p.target.y);
    };
    return Math.max(distance(pair), pair.controls.length ? pair.controls.reduce((s, p) => s + distance(p), 0) / pair.controls.length : 0);
  }

  const searchMargin = (width, height) => Math.min(48, Math.max(12, Math.max(width, height) * 0.03));

  function chooseFit(markers, dimensions, adapter, projective, width, height) {
    const layout = adapter.layout(dimensions.originalWidth, dimensions.originalHeight);
    const pairs = markers.map((marker) => centrePair(marker, layout, adapter));
    const count = projective ? 4 : 3;
    if (pairs.length < count) return null;
    let best = null;
    const consider = (matrix, controls) => {
      if (!matrix || !validGeometry(matrix, dimensions.originalWidth, dimensions.originalHeight, width, height, searchMargin(width, height))) return;
      const inliers = pairs.filter((pair) => measurementError(matrix, pair) < 2.5);
      if (inliers.length < count) return;
      const error = inliers.reduce((s, pair) => s + measurementError(matrix, pair), 0);
      if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && error < best.error)) best = { matrix, inliers, error, controls };
    };
    for (const sample of subsets(pairs, count)) {
      if (separated(sample)) consider(fitPoints(sample, projective), false);
    }
    if (projective) {
      // Local directions remove the ambiguity of a centre-only fit. Use three
      // spatially separated, independently refined patches to propose it, then
      // require agreement from at least four whole patches, not four control points.
      const measured = pairs.filter((pair) => pair.controls.length);
      for (const sample of subsets(measured, 3)) {
        if (separated(sample)) consider(fitPoints(controlPairs(sample), true), true);
      }
    }
    if (!best) return null;
    const refitted = fitPoints(best.controls ? controlPairs(best.inliers) : best.inliers, projective);
    if (refitted && validGeometry(refitted, dimensions.originalWidth, dimensions.originalHeight, width, height, searchMargin(width, height)) &&
        best.inliers.every((pair) => measurementError(refitted, pair) < 2.5)) best.matrix = refitted;
    return best;
  }

  function rankMappings(candidates, markers, seed, adapter, width, height, minimum = 1) {
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    const pairs = markers.map((marker) => centrePair(marker, layout, adapter));
    const ranked = [];
    for (const candidate of candidates) {
      if (!validGeometry(candidate.matrix, seed.originalWidth, seed.originalHeight, width, height, searchMargin(width, height))) continue;
      let score = 0;
      for (const marker of markers) score += adapter.quality(patchMatrix(candidate.matrix, layout.find((p) => p.id === marker.id)), marker.id, seed);
      if (!Number.isFinite(score)) continue;
      const inliers = pairs.filter((pair) => measurementError(candidate.matrix, pair) < 2.5);
      if (inliers.length >= (typeof minimum === "function" ? minimum(candidate.model) : minimum))
        ranked.push({ ...candidate, score: score / markers.length, inliers });
    }
    ranked.sort((a, b) => b.score - a.score);
    const distinct = [];
    for (const candidate of ranked) {
      const corners = quad(candidate.matrix, seed.originalWidth, seed.originalHeight);
      if (distinct.some((other) => quad(other.matrix, seed.originalWidth, seed.originalHeight)
        .every((p, i) => Math.hypot(p.x - corners[i].x, p.y - corners[i].y) < 2))) continue;
      distinct.push(candidate);
      if (distinct.length === 3) break;
    }
    return distinct;
  }

  function fromSeed(seed, adapter, tangent = false) {
    const patch = adapter.layout(seed.originalWidth, seed.originalHeight).find((p) => p.id === seed.id);
    // An outline can include a piece of the surrounding scene. Its projective
    // terms may still fit one small verified patch but extrapolate far outside
    // the other corners. The measured local centre/axes give a second, affine
    // prediction without treating that unverified curvature as established.
    const matrix = tangent ? basisMatrix(matrixBasis(seed.matrix, adapter), adapter) : seed.matrix;
    return multiply(matrix, [1, 0, -patch.x, 0, 1, -patch.y, 0, 0, 1]);
  }

  async function refineConfirmation(confirmed, adapter, seed, options) {
    if (options.signal?.aborted) check(options);
    if (Date.now() >= options.deadline) return confirmed;
    try { return await refine(confirmed, adapter, seed, options) || confirmed; }
    catch (error) {
      // Refining a confirmed header/pattern is optional. A time limit must not
      // discard the patch we have already read; cancellation must still abort.
      if (error?.name === "SearchLimit") return confirmed;
      throw error;
    }
  }

  async function findNear(matrix, patch, seed, adapter, options, radius, fullPattern = false) {
    if (options.signal?.aborted) check(options);
    const prediction = patchMatrix(matrix, patch), peaks = [];
    const direct = adapter.confirm(prediction, patch.id, seed);
    if (direct) return refineConfirmation(direct, adapter, seed, options);
    const stride = options.camera ? Math.max(2, Math.min(8, Math.round(radius / 16))) : (radius > 30 ? 4 : 2);
    let row = 0;
    for (let y = -radius; y <= radius; y += stride) {
      check(options);
      for (let x = -radius; x <= radius; x += stride) {
        const trial = offsetMatrix(prediction, x, y);
        const score = adapter.quality(trial, patch.id, fullPattern ? seed : undefined);
        if (score > 0.32) keepPeak(peaks, { matrix: trial, id: patch.id, x, y, score }, fullPattern ? 12 : 32, 5);
      }
      if (!options.camera || (row & 7) === 7) await pause();
      row++;
    }
    // The dimensions are known here. Rank the complete 96-symbol pattern,
    // rather than letting a convincing 24-symbol prefix consume every fit.
    if (!fullPattern) for (const peak of peaks) peak.score = adapter.quality(peak.matrix, patch.id, seed);
    peaks.sort((a, b) => b.score - a.score);
    for (const peak of peaks.slice(0, options.camera && radius > 24 ? 3 : 8)) {
      const read = await refine(peak, adapter, seed, options, true);
      if (read) return read;
    }
    return null;
  }

  function localPrediction(matrix, patch, markers, seed, adapter) {
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    const predicted = patchMatrix(matrix, patch), b = matrixBasis(predicted, adapter), residual = new Array(6).fill(0);
    let total = 0;
    for (const marker of markers) {
      if (!marker.localized || marker.quality < 0.6) continue;
      const other = layout.find((p) => p.id === marker.id);
      const measured = matrixBasis(marker.matrix, adapter), expected = matrixBasis(patchMatrix(matrix, other), adapter);
      const distance = ((patch.x - other.x) / seed.originalWidth) ** 2 + ((patch.y - other.y) / seed.originalHeight) ** 2;
      const weight = marker.quality ** 2 / Math.max(0.005, distance);
      for (let i = 0; i < 6; i++) residual[i] += weight * (measured[i] - expected[i]);
      total += weight;
    }
    if (!total) return null;
    for (let i = 0; i < 6; i++) b[i] += residual[i] / total;
    if (!reasonableBasis(b) || Math.hypot(residual[0], residual[1]) / total > 32) return null;
    return basisMatrix(b, adapter);
  }

  async function retryMissing(markers, seed, adapter, candidates, width, height, options, attempts) {
    let added = false;
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    for (const patch of layout.filter((p) => !markers.some((m) => m.id === p.id))) {
      if (options.signal?.aborted) check(options);
      if (Date.now() >= options.deadline) break;
      const localOptions = { ...options, deadline: Math.min(options.deadline, Date.now() + 1200) };
      attempts.set(patch.id, { ...attempts.get(patch.id), finalRetry: true, reason: "not-confirmed" });
      options.onProgress?.("Rechecking missing marker " + patch.id + " with the refined alignment (" + markers.length + "/" + adapter.ids.length + ")…");
      try {
        for (const candidate of candidates.slice(0, 2)) {
          // A lens-deformed patch may follow neighbouring measured axes more
          // closely than the global plane. Both trials must verify its pattern.
          const local = localPrediction(candidate.matrix, patch, markers, seed, adapter);
          const starts = [patchMatrix(candidate.matrix, patch), ...(local ? [local] : [])];
          let found;
          for (const prediction of starts) {
            const direct = adapter.confirm(prediction, patch.id, seed);
            found = direct ? await refineConfirmation(direct, adapter, seed, localOptions)
              : await refine({ matrix: prediction, id: patch.id }, adapter, seed, localOptions, true);
            if (found) break;
          }
          if (!found) found = await findNear(candidate.matrix, patch, seed, adapter, localOptions, 12, true);
          if (found) {
            markers.push(found); added = true;
            attempts.set(patch.id, { ...attempts.get(patch.id), reason: "confirmed" });
            break;
          }
        }
      } catch (error) {
        if (error?.name !== "SearchLimit") throw error;
        attempts.set(patch.id, { ...attempts.get(patch.id), reason: "time-limit" });
      }
    }
    return added;
  }

  function quad(matrix, width, height) {
    return [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]].map(([x, y]) => point(matrix, x, y));
  }

  function validGeometry(matrix, originalWidth, originalHeight, width, height, margin = 3) {
    if (!matrix || matrix.some((v) => !Number.isFinite(v))) return false;
    const corners = quad(matrix, originalWidth, originalHeight);
    const denominators = [[0, 0], [originalWidth - 1, 0], [originalWidth - 1, originalHeight - 1], [0, originalHeight - 1]]
      .map(([x, y]) => matrix[6] * x + matrix[7] * y + matrix[8]);
    // Homographies are unchanged by multiplying all coefficients by a constant.
    // Test the denominator relative to its value at the image centre.
    const middle = denominators.reduce((s, d) => s + d, 0) / 4;
    if (!Number.isFinite(middle) || Math.abs(middle) < 1e-12 || denominators.some((d) => d / middle <= 0.05)) return false;
    if (corners.some((p) => !Number.isFinite(p.x + p.y) || p.x < -margin || p.y < -margin || p.x > width - 1 + margin || p.y > height - 1 + margin)) return false;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
      if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
    }
    return true;
  }

  async function refineGlobal(matrix, markers, seed, adapter, width, height, options) {
    const source = [seed.originalWidth / 2, 0, seed.originalWidth / 2, 0, seed.originalHeight / 2, seed.originalHeight / 2, 0, 0, 1];
    const target = [width / 2, 0, width / 2, 0, height / 2, height / 2, 0, 0, 1];
    let normalized = multiply(invert(target), multiply(matrix, source));
    normalized = normalized.map((v) => v / normalized[8]);
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    const toImage = (h) => multiply(target, multiply(h, invert(source)));
    const quality = (h) => {
      const transform = toImage(h);
      // Coarse fits may overshoot an edge slightly. Allow refinement to approach
      // the boundary; the final result still has the stricter three-pixel check.
      if (!validGeometry(transform, seed.originalWidth, seed.originalHeight, width, height, searchMargin(width, height))) return -Infinity;
      let value = 0;
      for (const marker of markers) value += adapter.quality(patchMatrix(transform, layout.find((p) => p.id === marker.id)), marker.id, seed);
      return value / markers.length;
    };
    let score = quality(normalized);
    for (const pixels of [1.5, 0.75, 0.3, 0.12, 0.04]) {
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let axis = 0; axis < (options.mode === "perspective" ? 8 : 6); axis++) {
          const step = pixels * 2 / Math.max(width, height);
          let best = normalized, bestScore = score;
          for (const sign of [-1, 1]) {
            const trial = normalized.slice(); trial[axis] += sign * step;
            const value = quality(trial);
            if (value > bestScore) { best = trial; bestScore = value; }
          }
          if (best !== normalized) { changed = true; normalized = best; score = bestScore; }
        }
        check(options); await pause();
        if (!changed) break;
      }
    }
    return toImage(normalized);
  }

  function geometryFor(matrix, seed, markers, adapter, model) {
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    const pairs = markers.map((marker) => centrePair(marker, layout, adapter));
    const inliers = pairs.filter((pair) => measurementError(matrix, pair) < 2.5);
    const positions = inliers.map((p) => p.source);
    const coverage = positions.length ?
      (Math.max(...positions.map((p) => p.x)) - Math.min(...positions.map((p) => p.x))) / seed.originalWidth *
      (Math.max(...positions.map((p) => p.y)) - Math.min(...positions.map((p) => p.y))) / seed.originalHeight : 0;
    const patternQuality = markers.reduce((sum, marker) => sum +
      adapter.quality(patchMatrix(matrix, layout.find((p) => p.id === marker.id)), marker.id, seed), 0) / markers.length;
    const fitError = inliers.length ? inliers.reduce((sum, pair) => sum + measurementError(matrix, pair), 0) / inliers.length : 2.5;
    const headerCount = inliers.filter((p) => p.marker.verification === "header").length;
    return { matrix, originalWidth: seed.originalWidth, originalHeight: seed.originalHeight,
      carrierVersion: adapter.carrierVersion, markerTotal: adapter.ids.length, patchWidth: adapter.patchWidth, patchHeight: adapter.patchHeight,
      model, markerCount: markers.length, headerCount: markers.filter((m) => m.verification === "header").length,
      patternCount: markers.filter((m) => m.verification === "pattern").length,
      inlierCount: inliers.length, patternQuality, coverage, fitError,
      missingMarkerIds: adapter.ids.filter((id) => !markers.some((m) => m.id === id)),
      misalignedMarkerIds: markers.filter((m) => !inliers.some((p) => p.marker.id === m.id)).map((m) => m.id),
      rank: 100 * patternQuality + 3 * inliers.length + 10 * coverage + headerCount - 2 * fitError,
      highConfidence: inliers.length === adapter.ids.length && headerCount >= 2 && patternQuality >= 0.9 && coverage >= 0.6 && fitError <= 0.6,
      expectedMarkers: layout.map((p) => ({ id: p.id, patchWidth: adapter.patchWidth, patchHeight: adapter.patchHeight, matrix: patchMatrix(matrix, p) })),
      corners: quad(matrix, seed.originalWidth, seed.originalHeight) };
  }

  function geometryCandidates(markers, seed, predictions, adapter, width, height, mode) {
    if (!seed) return [];
    const proposals = [];
    if (markers.length >= 2) {
      const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
      const translations = markers.map((marker) => {
        const pair = centrePair(marker, layout, adapter);
        return { marker, x: pair.target.x - pair.source.x, y: pair.target.y - pair.source.y };
      });
      const agreeing = translations.filter((p) => Math.hypot(p.x - translations[0].x, p.y - translations[0].y) < 0.6);
      if (agreeing.length >= 2) {
        const matrix = [1, 0, agreeing.reduce((s, p) => s + p.x, 0) / agreeing.length,
          0, 1, agreeing.reduce((s, p) => s + p.y, 0) / agreeing.length, 0, 0, 1];
        proposals.push({ matrix, model: "translation" });
      }
    }
    if (mode !== "padding" && markers.length >= 3) {
      const fit = chooseFit(markers, seed, adapter, false, width, height);
      if (fit) proposals.push({ matrix: fit.matrix, model: "affine" });
    }
    if (mode === "perspective") {
      const fit = chooseFit(markers, seed, adapter, true, width, height);
      if (fit) proposals.push({ matrix: fit.matrix, model: "perspective" });
    }
    proposals.push(...predictions);
    const minimum = (model) => model === "translation" ? 2 : model === "affine" ? 3 : 4;
    const margin = Math.max(3, Math.min(12, Math.max(width, height) * 0.01));
    return rankMappings(proposals, markers, seed, adapter, width, height, minimum)
      .filter((p) => p.inliers.length >= minimum(p.model) &&
        validGeometry(p.matrix, seed.originalWidth, seed.originalHeight, width, height, margin))
      .map((p) => geometryFor(p.matrix, seed, markers, adapter, p.model))
      .sort((a, b) => b.rank - a.rank);
  }

  async function find(pixels, width, height, requested, adapter) {
    const adapters = Array.isArray(adapter) ? adapter : [adapter];
    adapter = adapters.find((a) => a.carrierVersion === (requested.refinementState?.seed || requested.seed)?.carrierVersion) || adapters[0];
    const deadline = Math.min(Date.now() + 60000, requested.deadline || Infinity);
    const options = { ...requested, deadline: Math.min(deadline, requested.seedDeadline || Infinity),
      markerRatios: [...new Set(adapters.map((a) => 1 / (a.sampleStep || 1.5)))],
      mode: ["padding", "affine", "perspective"].includes(requested.mode) ? requested.mode : "padding" };
    options.check = () => check(options);
    let signature = null;
    const markers = [];
    const attempts = new Map();
    let seed = null, predictions = [];
    const evidence = () => ({ pilotQuality: options.pilotQuality || 0 });
    try {
      let candidates;
      if (requested.refinementState) {
        const state = requested.refinementState;
        seed = state.seed;
        markers.push(...state.markers);
        for (const [id, attempt] of state.attempts) attempts.set(id, attempt);
        predictions = state.predictions;
        signature = state.signature;
        candidates = state.candidates;
        options.deadline = deadline;
      } else {
      // A previous pyramid level may already have read a checksum-valid header.
      // Confirm it against these pixels before reusing its dimensions/position;
      // this avoids rediscovering the same patch from scratch at every scale.
      seed = requested.seed && adapter.confirm(requested.seed.matrix, requested.seed.id, requested.seed);
      if (seed) seed = { ...requested.seed, ...seed };
      else {
        const luma = new Float32Array(width * height);
        options.onProgress?.("Preparing wavelet search…");
        for (let i = 0; i < luma.length; i++) luma[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;
        if (requested.pilotFirst && requested.scaleGuide?.detected) {
          const {fx,fy} = requested.scaleGuide, squared = fx*fx+fy*fy;
          const scale = 1/(128*Math.sqrt(squared)), ux=fx/Math.sqrt(squared)*scale, uy=fy/Math.sqrt(squared)*scale;
          const edgeGuide = requested.scaleGuide.kind === "edge";
          signature = { likely:true, confirmed:false, scalePilot:!edgeGuide, edgeGuide,
            bases:[[ux,uy,-uy,ux],[-uy,ux,-ux,-uy],[-ux,-uy,uy,-ux],[uy,-ux,ux,uy]],
            message:(edgeGuide ? "Edge guide" : "Scale pilot") + " suggests a marker pitch. Checking marker headers…" };
          options.onSignature?.(signature);
          seed = await seedSearch(pixels,luma,width,height,adapters,options,signature);
        } else {
          // An isolated worker can reuse this exact tile's frequency result.
          // It remains a proposal: every accepted marker still reads its CRC.
          signature = requested.frequencySignature || await root.PixelStowSpectrum.analyze(luma, width, height, options);
          options.onSignature?.(signature);
          if (!signature.likely && !options.forceSearch && !options.corners?.length) return { geometry: null, markers, signature, evidence: evidence(), reason: signature.message };
          seed = await seedSearch(pixels, luma, width, height, adapters, options, signature);
        }
      }
      if (!seed) return { geometry: null, markers, evidence: evidence(),
        signature: { ...signature, confirmed: false, message: "No checksum-valid markers found. Frequency evidence alone does not confirm an encoded image." },
        reason: "No checksum-valid wavelet patch was found using the outline/frequency estimates." };
      adapter = adapters.find((a) => a.carrierVersion === seed.carrierVersion) || adapter;
      signature = { ...signature, likely: true, confirmed: true,
        message: "Recovery marker verified. Locating the remaining markers before reading contents…" };
      options.onSignature?.(signature);
      // Coarse pyramid levels have a short seed allowance. Once a header is
      // verified, keep its search state and use the remaining overall budget.
      options.deadline = deadline;
      markers.push(seed);
      attempts.set(seed.id, { rounds: 0, reason: "seed" });
      if (options.mode !== "padding") {
        const localized = await refine(seed, adapter, seed, options);
        if (localized) { seed = { ...seed, ...localized }; markers[0] = seed; }
      }
      // A live camera frame only needs the first verified corner. The following
      // frames track that marker directly instead of searching the other regions.
      if (requested.seedOnly) return { geometry: null, candidates: [], markers, signature, evidence: evidence(),
        markerSearch: adapter.ids.map((id) => ({ id, found: markers.some((marker) => marker.id === id), ...attempts.get(id) })) };
      let matrix = seed.initialMatrix || fromSeed(seed, adapter), model = "translation";
      const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
      predictions = [{ matrix, model: options.mode === "padding" ? "translation" : matrix[6] || matrix[7] ? "perspective" : "affine" }];
      if (seed.initialMatrix) predictions.push({ matrix: fromSeed(seed, adapter), model: "affine" });
      if (options.mode !== "padding" && (seed.matrix[6] || seed.matrix[7]))
        predictions.push({ matrix: fromSeed(seed, adapter, true), model: "affine" });
      for (let round = 0; round < (options.mode === "padding" ? 1 : 2); round++) {
        const pending = layout.filter((patch) => !markers.some((m) => m.id === patch.id));
        const spread = (patch) => Math.min(...markers.map((marker) => {
          const other = layout.find((p) => p.id === marker.id);
          return ((patch.x - other.x) / seed.originalWidth) ** 2 + ((patch.y - other.y) / seed.originalHeight) ** 2;
        }));
        while (pending.length) {
          // Prefer distant confirmations rather than first collecting a whole row.
          if (options.mode !== "padding") pending.sort((a, b) => spread(b) - spread(a));
          const patch = pending.shift();
          attempts.set(patch.id, { rounds: round + 1, reason: "searching" });
          options.onProgress?.("Found " + markers.length + "/" + adapter.ids.length + " markers. Locating marker " + patch.id + "…");
          let found = null;
          if (options.mode === "padding") {
            const expected = patchMatrix(matrix, patch);
            found = adapter.confirm(expected, patch.id, seed) || await refine({ matrix: expected, id: patch.id }, adapter, seed, options);
          } else {
            const radius = Math.min(64, Math.max(16, Math.round(Math.max(width, height) * (round ? 0.03 : 0.02))));
            // A local affine estimate remains a useful alternative while the
            // perspective estimate is still extrapolating from one side.
            for (const prediction of predictions) {
              found = await findNear(prediction.matrix, patch, seed, adapter, options, radius);
              if (found) break;
            }
          }
          attempts.set(patch.id, { rounds: round + 1, reason: found ? "confirmed" : "not-confirmed" });
          if (!found) continue;
          markers.push(found);
          if (options.mode !== "padding") {
            const candidates = predictions.slice();
            const affine = chooseFit(markers, seed, adapter, false, width, height);
            if (affine) candidates.push({ matrix: affine.matrix, model: "affine" });
            if (options.mode === "perspective") {
              const projective = chooseFit(markers, seed, adapter, true, width, height);
              if (projective) candidates.push({ matrix: projective.matrix, model: "perspective" });
            }
            const ranked = rankMappings(candidates, markers, seed, adapter, width, height);
            if (ranked.length) { predictions = ranked; matrix = ranked[0].matrix; model = ranked[0].model; }
          }
        }
      }
      candidates = geometryCandidates(markers, seed, predictions, adapter, width, height, options.mode);
      // Experiment: only a complete, strong V5 header fit can bypass global
      // refinement. Save the exact state so a failed body read resumes here.
      const early = candidates[0];
      if (requested.earlyPayload && options.mode !== "padding" && [5, 6].includes(adapter.carrierVersion) && early?.highConfidence &&
        early.headerCount === adapter.ids.length && early.patternQuality >= 0.95 && early.fitError <= 0.3) {
        return { geometry: early, candidates: [early], markers, signature, evidence: evidence(),
          markerSearch: adapter.ids.map(id => ({ id, found: true, ...attempts.get(id) })),
          refinementState: { seed, markers, attempts: [...attempts], predictions, signature, candidates, mode: options.mode } };
      }
      }
      const refinementDeadline = markers.length < adapter.ids.length ? deadline - 1500 : deadline;
      for (const candidate of candidates.slice()) {
        if (candidate.model === "translation") continue;
        if (Date.now() >= refinementDeadline) break;
        options.onProgress?.("Refining " + candidate.model + " alignment from " + candidate.inlierCount + " markers…");
        const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
        const inliers = markers.filter((m) => measurementError(candidate.matrix, centrePair(m, layout, adapter)) < 2.5);
        let refined;
        try {
          refined = await refineGlobal(candidate.matrix, inliers, seed, adapter, width, height,
            { ...options, deadline: refinementDeadline, mode: candidate.model });
        } catch (error) {
          if (error?.name !== "SearchLimit") throw error;
          break; // Preserve time for the missing patch instead of consuming it all.
        }
        if (validGeometry(refined, seed.originalWidth, seed.originalHeight, width, height,
          Math.max(3, Math.min(12, Math.max(width, height) * 0.01))))
          candidates.push(geometryFor(refined, seed, markers, adapter, candidate.model));
      }
      candidates.sort((a, b) => b.rank - a.rank);
      if (options.mode !== "padding" && candidates.length && markers.length < adapter.ids.length &&
        await retryMissing(markers, seed, adapter, candidates, width, height, options, attempts)) {
        // Re-evaluate refined planes with the new measured patch and include the
        // fit it enables; do not leave the newly recovered marker out of ranking.
        candidates = geometryCandidates(markers, seed, candidates.concat(predictions), adapter, width, height, options.mode);
      }
      const markerSearch = adapter.ids.map((id) => ({ id, found: markers.some((m) => m.id === id), ...attempts.get(id) }));
      options.onProgress?.("Marker scan complete: " + markers.length + "/" + adapter.ids.length +
        (candidates[0]?.missingMarkerIds.length ? "; missing IDs " + candidates[0].missingMarkerIds.join(", ") : "") + ".");
      // Small side references are optional cross-checks after corner discovery.
      // They do not inflate header counts, confidence or payload acceptance.
      if (candidates[0] && adapter.references) {
        candidates[0].referenceMarkers = adapter.references(candidates[0].matrix, seed);
        candidates[0].referenceCount = candidates[0].referenceMarkers.length;
      }
      return { geometry: candidates[0] || null, candidates, markers, markerSearch, signature, evidence: evidence(),
        reason: candidates.length ? undefined : "The verified markers did not establish a stable image transform." };
    } catch (error) {
      if (error?.name === "SearchLimit") {
        // A bounded camera scan can still return useful fits. It never reads a
        // payload, and it must not discard the already verified marker evidence.
        const candidates = geometryCandidates(markers, seed, predictions, adapter, width, height, options.mode);
        const markerSearch = adapter.ids.map((id) => {
          const attempt = attempts.get(id);
          return { id, found: markers.some((m) => m.id === id), ...attempt,
            reason: attempt?.reason === "searching" ? "time-limit" : attempt?.reason || "not-searched" };
        });
        return { geometry: candidates[0] || null, candidates, markers, markerSearch, signature, evidence: evidence(), reason: error.message };
      }
      throw error;
    }
  }

  function inEdgeBand(x, y, width, height, band) {
    if (!Number.isFinite(x + y)) return false;
    const insetX = width * band, insetY = height * band;
    return x >= 0 && y >= 0 && x < width && y < height &&
      (x < insetX || x >= width - insetX || y < insetY || y >= height - insetY);
  }

  function markerCentre(marker, adapter) {
    const w = marker.patchWidth || adapter.patchWidth, h = marker.patchHeight || adapter.patchHeight;
    return point(marker.matrix, (w - 1) / 2, (h - 1) / 2);
  }

  function markerInBand(marker, adapter, width, height, band) {
    const centrePoint = markerCentre(marker, adapter);
    return inEdgeBand(centrePoint.x, centrePoint.y, width, height, band);
  }

  function markerSquare(marker, adapter) {
    const w = marker.patchWidth || adapter.patchWidth, h = marker.patchHeight || adapter.patchHeight;
    return [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]].map(([x, y]) => point(marker.matrix, x, y));
  }

  function turnPatch(matrix, adapter, degrees) {
    if (!degrees) return matrix;
    const c = centre(adapter), origin = point(matrix, c.x, c.y);
    const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const spin = (x, y) => {
      const p = point(matrix, x, y), dx = p.x - origin.x, dy = p.y - origin.y;
      return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
    };
    const px = spin(c.x + 1, c.y), py = spin(c.x, c.y + 1);
    return basisMatrix([origin.x, origin.y, px.x - origin.x, px.y - origin.y, py.x - origin.x, py.y - origin.y], adapter);
  }

  async function acceptPose(prediction, patch, seed, adapter, options) {
    const direct = adapter.confirm(prediction, patch.id, seed);
    if (direct) return refineConfirmation({ ...direct, matrix: direct.matrix || prediction }, adapter, seed, options);
    return refine({ matrix: prediction, id: patch.id }, adapter, seed, options, true);
  }

  // A locked corner already has a scale. Search a window about the size of the
  // marker itself, coarse then fine, so a small camera movement does not drop it.
  function patchScale(matrix, adapter) {
    const c = centre(adapter), origin = point(matrix, c.x, c.y), axis = point(matrix, c.x + 1, c.y);
    return Math.hypot(axis.x - origin.x, axis.y - origin.y) || 1;
  }

  async function findAround(base, patch, seed, adapter, options, width, height) {
    const prediction = patchMatrix(base, patch);
    const close = await findNear(base, patch, seed, adapter, options, 16, true);
    if (close) return close;
    // The fine window is a few camera pixels. A photographed marker is wider
    // than that, so look about a third of a marker further before giving up.
    if (options.camera) {
      const scale = patchScale(prediction, adapter);
      const radius = Math.round(Math.max(24, Math.min(scale * 12, 140)));
      if (radius > 16) {
        const wider = await findNear(base, patch, seed, adapter, options, radius, true);
        if (wider) return wider;
      }
    }
    const spanScale = Math.hypot(base[0], base[3]) || 1;
    const span = spanScale * (adapter.patchWidth || 50);
    const limit = Math.max(width || 0, height || 0);
    const radius = Math.round(Math.max(64, Math.min(span * 1.5, limit ? limit * 0.18 : span * 1.5)));
    const stride = Math.max(6, Math.round(spanScale * 2.5));
    const peaks = [];
    for (let y = -radius; y <= radius; y += stride) {
      check(options);
      for (let x = -radius; x <= radius; x += stride) {
        if (x * x + y * y > radius * radius) continue;
        const score = adapter.quality(offsetMatrix(prediction, x, y), patch.id, seed);
        if (score > 0.32) keepPeak(peaks, { x, y, score }, 6, stride);
      }
      await pause();
    }
    peaks.sort((a, b) => b.score - a.score);
    const fine = Math.max(8, Math.round(stride * 0.75));
    for (const peak of peaks.slice(0, 3)) {
      const found = await findNear(offsetMatrix(base, peak.x, peak.y), patch, seed, adapter, options, fine, true);
      if (found) return found;
    }
    const best = peaks[0];
    if (!best) return null;
    const shifted = offsetMatrix(prediction, best.x, best.y);
    for (const degrees of [-8, 8, -16, 16]) {
      check(options);
      let turned;
      try { turned = turnPatch(shifted, adapter, degrees); }
      catch (error) { if (error?.name === "SearchLimit") throw error; continue; }
      try {
        const found = await acceptPose(turned, patch, seed, adapter, options);
        if (found) return found;
      } catch (error) { if (error?.name === "SearchLimit") return null; throw error; }
    }
    return null;
  }

  async function reacquireMarker(prior, adapter, seed, options, width, height) {
    const direct = adapter.confirm(prior.matrix, prior.id, seed);
    if (direct) return refineConfirmation({ ...direct, matrix: direct.matrix || prior.matrix }, adapter, seed, options);
    const layout = adapter.layout(seed.originalWidth, seed.originalHeight);
    const patch = layout?.find((item) => item.id === prior.id);
    if (!patch) return null;
    try { return await findAround(fromSeed({ ...seed, id: prior.id, matrix: prior.matrix }, adapter), patch, seed, adapter, options, width, height); }
    catch (error) { if (error?.name === "SearchLimit") return null; throw error; }
  }

  async function discoverBorderMarker(pixels, width, height, adapters, options) {
    const luma = new Float32Array(width * height);
    for (let i = 0; i < luma.length; i++) luma[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;
    // A live frame names one border region and one scale. The full-frame
    // spectrum estimate is only for a search that has no region of its own.
    const banks = [];
    if (options.discoveryScale > 0) banks.push([options.discoveryScale, 0, 0, options.discoveryScale]);
    if (!options.region) {
      const signature = root.PixelStowSpectrum ? await root.PixelStowSpectrum.analyze(luma, width, height, options) : { bases: [] };
      options.onSignature?.(signature);
      const extra = signature?.bases?.[0];
      if (extra && banks.length < 2) banks.push(extra);
    }
    if (!banks.length) banks.push([1, 0, 0, 1]);
    const preferred = adapters.find((adapter) => adapter.carrierVersion === 6) || adapters[0];
    const order = options.region ? [preferred] : [preferred, ...adapters.filter((adapter) => adapter !== preferred)];
    const accepted = (marker, adapter) => marker && markerInBand(marker, adapter, width, height, options.edgeBand);
    for (const basis of banks) {
      check(options);
      for (const adapter of order) {
        const peaks = await globalCandidates(luma, width, height, basis, adapter, options);
        for (const peak of peaks.slice(0, 8)) {
          if (!inSearchRegion(peak.x, peak.y, options.region) || !inEdgeBand(peak.x, peak.y, width, height, options.edgeBand)) continue;
          const direct = adapter.read(peak.matrix, peak.id);
          if (accepted(direct, adapter)) return direct;
        }
        for (const peak of peaks.slice(0, 4)) {
          if (!inSearchRegion(peak.x, peak.y, options.region) || !inEdgeBand(peak.x, peak.y, width, height, options.edgeBand)) continue;
          const refined = await refine(peak, adapter, null, options, true);
          if (accepted(refined, adapter)) return refined;
        }
      }
    }
    return null;
  }

  async function track(pixels, width, height, requested, adapters) {
    // Twenty percent of each edge is the readable border. The middle cannot
    // contain a corner that will decode, so it is not searched.
    const band = requested.edgeBand ?? 0.2;
    const ghostFrames = requested.ghostFrames ?? 4;
    const options = { ...requested, mode: requested.mode || "perspective", edgeBand: band,
      deadline: Math.min(requested.deadline || Infinity, Date.now() + (requested.maxMilliseconds || 800)) };
    options.check = () => check(options);
    const carried = Array.isArray(requested.tracks) ? requested.tracks.filter((marker) => marker?.matrix && Number.isFinite(marker.id)) : [];
    let adapter = adapters.find((item) => item.carrierVersion === (carried[0]?.carrierVersion || 6)) || adapters[0];
    const locked = [], ghosts = [];
    let interior = 0;
    try {
      if (carried.length && adapter) {
        const seed = { originalWidth: carried[0].originalWidth, originalHeight: carried[0].originalHeight,
          carrierVersion: carried[0].carrierVersion, id: carried[0].id, matrix: carried[0].matrix };
        adapter = adapters.find((item) => item.carrierVersion === seed.carrierVersion) || adapter;
        for (const prior of carried) {
          let found = null;
          try { found = await reacquireMarker(prior, adapter, seed, options, width, height); }
          catch (error) { if (error?.name !== "SearchLimit") throw error; }
          if (!found) {
            const misses = (prior.misses || 0) + 1;
            if (misses <= ghostFrames && markerInBand(prior, adapter, width, height, band))
              ghosts.push({ ...prior, misses, ghost: true });
            continue;
          }
          if (!markerInBand(found, adapter, width, height, band)) { interior++; continue; }
          locked.push({ ...found, misses: 0, ghost: false, seen: (prior.seen || 0) + 1 });
        }
        if (locked.length) {
          const basis = locked.slice().sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
          const dims = { originalWidth: basis.originalWidth, originalHeight: basis.originalHeight, carrierVersion: basis.carrierVersion };
          let plane = locked.length >= 3 ? chooseFit(locked, dims, adapter, locked.length >= 4, width, height) : null;
          let matrix = plane?.matrix || fromSeed(basis, adapter);
          const layout = adapter.layout(dims.originalWidth, dims.originalHeight) || [];
          const missing = layout.filter((patch) => !locked.some((marker) => marker.id === patch.id) && !ghosts.some((marker) => marker.id === patch.id));
          // Three locked corners project the remaining one. One or two only
          // propose the others at the same scale, and only inside the border.
          for (const patch of missing) {
            if (Date.now() >= options.deadline) break;
            const predicted = point(patchMatrix(matrix, patch), (adapter.patchWidth - 1) / 2, (adapter.patchHeight - 1) / 2);
            if (!inEdgeBand(predicted.x, predicted.y, width, height, band)) continue;
            const radius = locked.length >= 3 ? 20 : 36;
            let found = null;
            try { found = await findNear(matrix, patch, dims, adapter, options, radius, true); }
            catch (error) { if (error?.name !== "SearchLimit") throw error; }
            if (!found || !markerInBand(found, adapter, width, height, band)) continue;
            locked.push({ ...found, misses: 0, ghost: false, seen: 1 });
            if (locked.length >= 3) {
              const next = chooseFit(locked, dims, adapter, true, width, height);
              if (next) { plane = next; matrix = next.matrix; }
            }
          }
        }
      } else if (requested.discover !== false && adapters.length) {
        const found = await discoverBorderMarker(pixels, width, height, adapters, options);
        if (found) locked.push({ ...found, misses: 0, ghost: false, seen: 1 });
      }
    } catch (error) {
      if (error?.name !== "SearchLimit") throw error;
    }
    const tracks = locked.concat(ghosts);
    let geometry = null, candidates = [];
    if (locked.length && adapter) {
      const seed = locked.slice().sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
      try {
        candidates = geometryCandidates(locked, seed, [], adapter, width, height, options.mode);
        geometry = candidates[0] || null;
      } catch (error) { if (error?.name !== "SearchLimit") throw error; }
      if (geometry && adapter.references && locked.length >= adapter.ids.length) {
        const references = adapter.references(geometry.matrix, seed) || [];
        geometry = { ...geometry, referenceMarkers: references, referenceCount: references.length };
        if (candidates[0]) candidates[0] = geometry;
      }
    }
    const cornerIds = adapter?.ids || [];
    const cornersLocked = cornerIds.length > 0 && cornerIds.every((id) => locked.some((marker) => marker.id === id));
    // Four locked corners are already a plane. A tight file-recovery fit must
    // not leave the camera capturing after the corners are in hand.
    if (cornersLocked && !geometry && adapter) {
      const seed = locked.slice().sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
      try {
        const layout = adapter.layout(seed.originalWidth, seed.originalHeight) || [];
        const pairs = [];
        for (const marker of locked) {
          if (!layout.some((patch) => patch.id === marker.id) || !marker.matrix) continue;
          pairs.push(centrePair(marker, layout, adapter));
        }
        const matrix = pairs.length >= 4 ? fitPoints(pairs, true) : null;
        if (matrix?.every((value) => Number.isFinite(value))) {
          geometry = geometryFor(matrix, seed, locked, adapter, "perspective");
          candidates = geometry ? [geometry] : [];
        }
      } catch (error) { if (error?.name === "SearchLimit") throw error; }
    }
    const cornerTotal = adapter?.ids.length || 4;
    const squares = tracks.map((marker) => ({ id: marker.id, ghost: Boolean(marker.ghost),
      corners: markerSquare(marker, adapter) }));
    return { tracks, markers: locked, ghosts, squares, geometry, candidates, interior, edgeBand: band,
      ready: Boolean(cornersLocked && geometry),
      signature: { confirmed: locked.length > 0, likely: locked.length > 0,
        message: locked.length ? "Tracking " + locked.length + " of " + cornerTotal + " corner markers" +
          (ghosts.length ? "; still checking " + ghosts.length + " lost marker" + (ghosts.length === 1 ? "" : "s") : "") + "."
          : interior ? "A marker moved into the middle of the picture, where it cannot be read."
          : "Looking for corner markers along the edges of the picture." } };
  }

  root.PixelStowTransform = { find, invert, point, proposeOutlines, track, inEdgeBand, borderSlice };
})(typeof window !== "undefined" ? window : self);
