// Whole-image Fourier triage for the 4-pixel carrier / 6-pixel locator families.
// Heuristic evidence only: exact headers and frame CRC remain the acceptance test.
(function (root) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const powerOfTwo = (value) => { let n = 1; while (n < value) n *= 2; return n; };

  function fft(real, imaginary) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const angle = -2 * Math.PI / length, cr = Math.cos(angle), ci = Math.sin(angle);
      for (let start = 0; start < n; start += length) {
        let wr = 1, wi = 0;
        for (let k = 0; k < length / 2; k++) {
          const a = start + k, b = a + length / 2;
          const tr = wr * real[b] - wi * imaginary[b], ti = wr * imaginary[b] + wi * real[b];
          real[b] = real[a] - tr; imaginary[b] = imaginary[a] - ti;
          real[a] += tr; imaginary[a] += ti;
          const next = wr * cr - wi * ci; wi = wr * ci + wi * cr; wr = next;
        }
      }
    }
  }

  function taper(position, span) {
    const edge = Math.min(position, span - 1 - position), ramp = Math.max(1, span * 0.08);
    // Retain evidence from the outer locator patches while reducing border leakage.
    return edge >= ramp ? 1 : 0.4 + 0.6 * (1 - Math.cos(Math.PI * edge / ramp)) / 2;
  }

  function wrap(value, length) { return ((value % length) + length) % length; }

  function contrast(power, width, height, x, y, floor) {
    let noise = 0;
    for (const [dx, dy] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-6, -6], [-6, 6], [6, -6], [6, 6]]) {
      noise += power[wrap(x + dx, width) + wrap(y + dy, height) * width];
    }
    return power[x + y * width] / Math.max(floor, noise / 8);
  }

  function strongestNear(power, width, height, fx, fy, floor) {
    const x = wrap(Math.round(fx * width), width), y = wrap(Math.round(fy * height), height);
    let best = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      best = Math.max(best, contrast(power, width, height, wrap(x + dx, width), wrap(y + dy, height), floor));
    }
    return best;
  }

  function unalias(peak, stride) {
    const values = [], reach = Math.ceil(stride / 2);
    for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) {
      const fx = (peak.fx + x) / stride, fy = (peak.fy + y) / stride, radius = Math.hypot(fx, fy);
      if (radius >= 0.095 && radius <= 0.57 && Math.abs(fx) <= 0.5 && Math.abs(fy) <= 0.5) values.push({ ...peak, fx, fy });
    }
    return values;
  }

  function reducedBasis(basis) {
    // The common carrier has both axis and diagonal peaks. An axis/diagonal
    // pair describes the same lattice with a sheared basis. Reduce that lattice
    // before trying it, while retaining the unreduced estimate for real shear.
    let [ux, uy, vx, vy] = basis;
    for (let pass = 0; pass < 4; pass++) {
      if (ux * ux + uy * uy > vx * vx + vy * vy) [ux, uy, vx, vy] = [vx, vy, -ux, -uy];
      const multiple = Math.round((ux * vx + uy * vy) / (ux * ux + uy * uy));
      if (!multiple) break;
      vx -= multiple * ux; vy -= multiple * uy;
    }
    return [ux, uy, vx, vy];
  }

  function rotations([ux, uy, vx, vy]) {
    return [[ux, uy, vx, vy], [vx, vy, -ux, -uy], [-ux, -uy, -vx, -vy], [-vx, -vy, ux, uy]];
  }

  function matchesGuide(basis, guides, tolerance) {
    if (!guides?.length) return true;
    const lengths = b => [Math.hypot(b[0], b[1]), Math.hypot(b[2], b[3])].sort((a,b)=>a-b);
    const actual = lengths(basis);
    return guides.some(guide => lengths(guide).every((value,i) => actual[i] >= value / tolerance && actual[i] <= value * tolerance));
  }

  async function analyze(luma, width, height, options) {
    let stride = Math.max(1, Math.ceil(Math.max(width, height) / 2048));
    if (stride % 2 === 0) stride++; // Even decimation can erase a four-pixel lattice.
    const sampledWidth = Math.ceil(width / stride), sampledHeight = Math.ceil(height / stride);
    const fw = powerOfTwo(sampledWidth), fh = powerOfTwo(sampledHeight);
    // Small camera tiles do not need timer yields. An isolated lab worker can
    // also process its larger root FFT continuously; ordinary photographs yield.
    const fast = options.fast === true && (fw * fh <= 512 * 512 || options.continuousWorker === true);
    const beat = async () => { options.check(); if (!fast) await pause(); };
    options.onProgress?.("Checking the whole-image frequency signature…");
    let real = options.searchCompute?.spectrum(luma,width,height,stride,fw,fh);
    const gpuSpectrum = Boolean(real);
    if (!real) {
    real = new Float32Array(fw * fh);
    const imaginary = new Float32Array(real.length);
    for (let y = 0; y < sampledHeight; y++) {
      if ((y & 31) === 0) { await beat(); }
      for (let x = 0; x < sampledWidth; x++) {
        const sx = Math.min(width - 1, x * stride), sy = Math.min(height - 1, y * stride), i = sx + sy * width;
        const neighbours = luma[Math.max(0, sx - 1) + sy * width] + luma[Math.min(width - 1, sx + 1) + sy * width] +
          luma[sx + Math.max(0, sy - 1) * width] + luma[sx + Math.min(height - 1, sy + 1) * width];
        real[x + y * fw] = (luma[i] * 4 - neighbours) * taper(x, sampledWidth) * taper(y, sampledHeight);
      }
    }
    for (let y = 0; y < fh; y++) {
      if ((y & 31) === 0) { await beat(); }
      fft(real.subarray(y * fw, (y + 1) * fw), imaginary.subarray(y * fw, (y + 1) * fw));
    }
    const columnReal = new Float32Array(fh), columnImaginary = new Float32Array(fh);
    for (let x = 0; x < fw; x++) {
      if ((x & 31) === 0) { await beat(); }
      for (let y = 0; y < fh; y++) { columnReal[y] = real[x + y * fw]; columnImaginary[y] = imaginary[x + y * fw]; }
      fft(columnReal, columnImaginary);
      for (let y = 0; y < fh; y++) { real[x + y * fw] = columnReal[y]; imaginary[x + y * fw] = columnImaginary[y]; }
    }
    for (let i = 0; i < real.length; i++) real[i] = real[i] ** 2 + imaginary[i] ** 2;
    }
    let total = 0;
    for (let i = 0; i < real.length; i++) total += real[i];
    const mean = total / real.length, floor = Math.max(1e-8, mean * 0.01), peaks = [];
    for (let y = 0; y <= fh / 2; y++) {
      if ((y & 31) === 0) { await beat(); }
      for (let x = 0; x < fw; x++) {
        const fx = (x <= fw / 2 ? x : x - fw) / fw, fy = y / fh, radius = Math.hypot(fx, fy);
        const value = real[x + y * fw];
        if ((y === 0 && fx <= 0) || radius < 0.075 || radius > 0.65 || value < mean * 6) continue;
        const ratio = contrast(real, fw, fh, x, y, floor);
        if (ratio < 7) continue;
        const score = value * Math.min(ratio, 80);
        if (peaks.length === 192 && score <= peaks[peaks.length - 1].score) continue;
        const peak = { x, y, fx, fy, score, contrast: ratio };
        const index = peaks.findIndex((p) => p.score < score);
        peaks.splice(index < 0 ? peaks.length : index, 0, peak);
        if (peaks.length > 192) peaks.pop();
      }
    }
    const distinct = [];
    for (const peak of peaks) {
      if (distinct.some((p) => Math.hypot((p.fx - peak.fx) * fw, (p.fy - peak.fy) * fh) < 5)) continue;
      // A small centroid corrects fractional FFT-bin rotation/scale estimates.
      let sum = 0, dx = 0, dy = 0;
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const value = real[wrap(peak.x + x, fw) + wrap(peak.y + y, fh) * fw];
        sum += value; dx += x * value; dy += y * value;
      }
      distinct.push({ ...peak, fx: peak.fx + dx / Math.max(sum, 1e-8) / fw, fy: peak.fy + dy / Math.max(sum, 1e-8) / fh });
      if (distinct.length === (options.maxPeaks || 12)) break;
    }
    const expanded = distinct.flatMap((p) => unalias(p, stride)), candidates = [];
    let bestProminence = 0;
    for (let i = 0; i < expanded.length; i++) {
      if ((i & 7) === 0) { await beat(); }
      for (let j = i + 1; j < expanded.length; j++) {
        const a = expanded[i], b = expanded[j];
        if (a.x === b.x && a.y === b.y) continue;
        let bx = b.fx, by = b.fy, determinant = a.fx * by - a.fy * bx;
        const separation = Math.abs(determinant) / (Math.hypot(a.fx, a.fy) * Math.hypot(bx, by));
        if (separation < 0.65) continue;
        if (determinant < 0) { bx = -bx; by = -by; determinant = -determinant; }
        const basis = [0.25 * by / determinant, -0.25 * bx / determinant, -0.25 * a.fy / determinant, 0.25 * a.fx / determinant];
        const u = Math.hypot(basis[0], basis[1]), v = Math.hypot(basis[2], basis[3]);
        if (u < 0.45 || v < 0.45 || u > 2.4 || v > 2.4) continue;
        const markerBand = (options.markerRatios || [2 / 3, 4 / 5]).some((ratio) => Math.max(
          strongestNear(real, fw, fh, a.fx * stride * ratio, a.fy * stride * ratio, floor),
          strongestNear(real, fw, fh, bx * stride * ratio, by * stride * ratio, floor)) >= 3);
        // Common carrier tiles have axis and diagonal peaks. Prefer an axis pair
        // supported by its sum/difference, rather than treating diagonals as axes.
        const diagonalBand = Math.max(strongestNear(real, fw, fh, (a.fx + bx) * stride, (a.fy + by) * stride, floor),
          strongestNear(real, fw, fh, (a.fx - bx) * stride, (a.fy - by) * stride, floor)) >= 7;
        const score = Math.sqrt(a.score * b.score) * separation * (markerBand ? 1.5 : 1) * (diagonalBand ? 2 : 1);
        // Ordinary photographs have many isolated FFT peaks. Require both
        // independent directions to stand above the whole-spectrum noise floor,
        // rather than accepting any pair of locally prominent texture peaks.
        const prominence = Math.min(a.score / Math.min(a.contrast, 80), b.score / Math.min(b.contrast, 80)) / Math.max(mean, 1e-8);
        if (prominence > bestProminence) bestProminence = prominence;
        if (prominence < 32 || !diagonalBand) continue;
        // The lab's partition gate asks for a locator signature, rather than
        // the common carrier texture that may cover the whole encoded image.
        if (options.markerOnly && !markerBand) continue;
        candidates.push({ basis, score, markerBand, prominence });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const bases = [], selected = [], families = [];
    const maximumFamilies = options.maxFamilies || 3;
    let scaleRejected = 0;
    for (const candidate of candidates) {
      for (const basis of [reducedBasis(candidate.basis), candidate.basis]) {
        if (!matchesGuide(basis, options.basisGuides, options.basisTolerance || 1.65)) { scaleRejected++; continue; }
        const turns = rotations(basis);
        if (selected.some((b) => turns.some((t) => t.every((v, i) => Math.abs(v - b[i]) < 0.025)))) continue;
        selected.push(basis); bases.push(...turns);
        families.push({ basis, bases: turns, score: candidate.score / Math.max(mean, 1e-8),
          prominence: candidate.prominence, markerBand: candidate.markerBand });
        if (selected.length === maximumFamilies) break;
      }
      if (selected.length === maximumFamilies) break;
    }
    const likely = bases.length > 0;
    return { likely, confirmed: false, markerBand: Boolean(families[0]?.markerBand), bases, families, scaleRejected, gpuSpectrum, stride, prominence: bestProminence,
      message: likely ? "Possible carrier frequencies found. Checking marker headers; encoding is not yet confirmed."
        : (options.forceSearch || options.corners?.length) ? "No clear encoding frequency signature detected. Continuing with the precheck overridden."
          : "No clear encoding frequency signature detected at this scale." };
  }

  async function scaleGuide(pixels, width, height, pilot, options = {}) {
    // A scale hint only. The guided attempt must still verify marker headers
    // and the payload. Low-confidence/missing pilots leave ordinary discovery.
    const deadline = Math.min(options.deadline || Infinity, Date.now() + 750);
    const check = () => {
      if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      if (Date.now() >= deadline) { const error = new Error("Pilot appraisal time limit."); error.name = "PilotLimit"; throw error; }
    };
    const phaseCode = pilot.tones[0].phase + pilot.tones[1].phase - pilot.tones[2].phase;
    const angleError = value => Math.abs(Math.atan2(Math.sin(value), Math.cos(value)));
    async function region(left, top, regionWidth, regionHeight) {
      const reduction = Math.max(1, Math.max(regionWidth, regionHeight) / 128);
      const w = Math.max(2, Math.round(regionWidth / reduction)), h = Math.max(2, Math.round(regionHeight / reduction));
      const fw = powerOfTwo(w * 2), fh = powerOfTwo(h * 2);
      const luma = new Float64Array(w * h), real = new Float64Array(fw * fh), imaginary = new Float64Array(real.length);
      let mean = 0, slopeX = 0, slopeY = 0, normX = 0, normY = 0;
      for (let y = 0; y < h; y++) {
        if ((y & 15) === 0) { check(); if ((y & 63) === 0) await pause(); }
        const y0 = top + Math.floor(y * regionHeight / h), y1 = top + Math.floor((y + 1) * regionHeight / h);
        for (let x = 0; x < w; x++) {
          const x0 = left + Math.floor(x * regionWidth / w), x1 = left + Math.floor((x + 1) * regionWidth / w);
          let value = 0;
          for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
            const i = (sx + sy * width) * 4; value += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          }
          value /= Math.max(1, (x1 - x0) * (y1 - y0));
          luma[x + y * w] = value; mean += value;
          const dx = x - (w - 1) / 2, dy = y - (h - 1) / 2;
          slopeX += dx * value; slopeY += dy * value; normX += dx * dx; normY += dy * dy;
        }
      }
      mean /= w * h; slopeX /= normX; slopeY /= normY;
      let weightSum = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const weight = (.5 - .5 * Math.cos(2 * Math.PI * x / (w - 1))) * (.5 - .5 * Math.cos(2 * Math.PI * y / (h - 1)));
        real[x + y * fw] = (luma[x + y * w] - mean - slopeX * (x - (w - 1) / 2) - slopeY * (y - (h - 1) / 2)) * weight;
        weightSum += weight;
      }
      for (let y = 0; y < fh; y++) {
        if ((y & 31) === 0) { check(); if ((y & 127) === 0) await pause(); }
        fft(real.subarray(y * fw, (y + 1) * fw), imaginary.subarray(y * fw, (y + 1) * fw));
      }
      const columnReal = new Float64Array(fh), columnImaginary = new Float64Array(fh);
      for (let x = 0; x < fw; x++) {
        if ((x & 31) === 0) { check(); if ((x & 127) === 0) await pause(); }
        for (let y = 0; y < fh; y++) { columnReal[y] = real[x + y * fw]; columnImaginary[y] = imaginary[x + y * fw]; }
        fft(columnReal, columnImaginary);
        for (let y = 0; y < fh; y++) { real[x + y * fw] = columnReal[y]; imaginary[x + y * fw] = columnImaginary[y]; }
      }
      const power = Float64Array.from(real, (value, i) => value * value + imaginary[i] * imaginary[i]);
      const at = (x, y) => wrap(x, fw) + wrap(y, fh) * fw;
      const centred = (x, y) => {
        const ix = Math.floor(x), iy = Math.floor(y); let re = 0, im = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = ix + dx, sy = iy + dy, i = at(sx, sy);
          const weight = (dx ? x - ix : 1 - x + ix) * (dy ? y - iy : 1 - y + iy);
          const angle = 2 * Math.PI * (sx * (w - 1) / (2 * fw) + sy * (h - 1) / (2 * fh));
          re += weight * (real[i] * Math.cos(angle) - imaginary[i] * Math.sin(angle));
          im += weight * (real[i] * Math.sin(angle) + imaginary[i] * Math.cos(angle));
        }
        const noise = [[6,0],[-6,0],[0,6],[0,-6],[8,8],[-8,8],[8,-8],[-8,-8]].map(([dx,dy]) => power[at(Math.round(x) + dx, Math.round(y) + dy)]).sort((a,b) => a-b);
        const p = re * re + im * im;
        return { phase: Math.atan2(im, re), amplitude: 2 * Math.sqrt(p) / weightSum, contrast: p / Math.max(1e-6, noise[4]) };
      };
      const peaks = [];
      for (let y = 0; y <= fh / 2; y++) {
        if ((y & 31) === 0) { check(); if ((y & 127) === 0) await pause(); }
        for (let x = 0; x < fw; x++) {
          const fx = (x <= fw / 2 ? x : x - fw) / fw, fy = y / fh;
          if ((y === 0 && fx <= 0) || Math.hypot(fx * fw, fy * fh) < 4) continue;
          const p = power[at(x,y)];
          if (p <= 1e-6 || [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]].some(([dx,dy]) => power[at(x+dx,y+dy)] > p)) continue;
          const refine = (a,b,c) => {
            const low=Math.log(a+1e-20),mid=Math.log(b+1e-20),high=Math.log(c+1e-20),denominator=low-2*mid+high;
            return Math.abs(denominator)<1e-12?0:Math.max(-.5,Math.min(.5,.5*(low-high)/denominator));
          };
          peaks.push({ x: (x <= fw / 2 ? x : x - fw) + refine(power[at(x-1,y)],p,power[at(x+1,y)]),
            y: y + refine(power[at(x,y-1)],p,power[at(x,y+1)]), power: p });
        }
      }
      const matches = [];
      for (const peak of peaks.sort((a,b) => b.power-a.power).slice(0,64)) for (const tone of pilot.tones) {
        const bx = peak.x / tone.k, by = peak.y / tone.k;
        const fx = bx * 2 / fw * w / regionWidth, fy = by * 2 / fh * h / regionHeight;
        const scale = 2 / (pilot.period * Math.hypot(fx,fy));
        if (!Number.isFinite(scale) || scale < .25 || scale > 8) continue;
        const measured = pilot.tones.map(t => centred(bx*t.k,by*t.k));
        if (measured.some(m => !Number.isFinite(m.contrast) || m.contrast < 8 || m.amplitude < .2)) continue;
        const gains = measured.map((m,i) => m.amplitude / pilot.tones[i].weight);
        if (Math.max(...gains) / Math.min(...gains) > 2.5) continue;
        const phase = measured[0].phase + measured[1].phase - measured[2].phase;
        const phaseError = Math.min(angleError(phase-phaseCode),angleError(phase+phaseCode));
        if (phaseError > .5) continue;
        matches.push({ scale, fx, fy, phaseError, contrast: Math.min(...measured.map(m=>m.contrast)),
          score: measured.reduce((s,m)=>s+Math.log(m.contrast),0)-4*phaseError });
      }
      return matches.sort((a,b)=>b.score-a.score)[0] || null;
    }
    try {
      if (!pilot || width < 128 || height < 96) return null;
      const full = await region(0,0,width,height);
      if (full && full.contrast >= 16 && full.phaseError < .4)
        return { ...full, detected: true, confirmed: false, width, height, agreement: false };
      const cropWidth = Math.round(width*.68), cropHeight = Math.round(height*.68);
      const crop = await region(Math.floor((width-cropWidth)/2),Math.floor((height-cropHeight)/2),cropWidth,cropHeight);
      const agree = full && crop && Math.abs(Math.log2(full.scale/crop.scale)) < .12 &&
        Math.abs(full.fx*crop.fy-full.fy*crop.fx) / Math.max(1e-9,Math.hypot(full.fx,full.fy)*Math.hypot(crop.fx,crop.fy)) < .15;
      const selected = agree ? (full.score > crop.score ? full : crop) : [full,crop].filter(m=>m && m.contrast>=16 && m.phaseError<.4).sort((a,b)=>b.score-a.score)[0];
      return selected ? { ...selected, detected: true, confirmed: false, width, height, agreement: Boolean(agree) } : null;
    } catch (error) {
      if (error?.name === "PilotLimit") return null;
      throw error;
    }
  }

  root.PixelStowSpectrum = { analyze, scaleGuide };
})(typeof window !== "undefined" ? window : self);
