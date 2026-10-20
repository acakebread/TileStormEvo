// Photograph-only recovery. This follows the carrier in the original capture;
// it neither writes a signal nor changes the native/generated-image reader.
(function (root) {
  "use strict";
  const PERIOD = 4, OMEGA = 2 * Math.PI / PERIOD;
  const SIZE = 48, SAMPLE = 0.5, STEP = 40;
  const RATIOS = [0.84, 0.88, 0.92, 0.96, 1, 1.04, 1.08, 1.12, 1.16];
  const CROSS = [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const wrap = (x) => x - PERIOD * Math.round(x / PERIOD);
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

  function point(h, x, y) {
    const d = h[6] * x + h[7] * y + h[8];
    return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
  }

  function basis(t, scale) {
    const t2 = t * t, t3 = t2 * t;
    return [[-0.5 * t + t2 - 0.5 * t3, 1 - 2.5 * t2 + 1.5 * t3,
      0.5 * t + 2 * t2 - 1.5 * t3, -0.5 * t2 + 0.5 * t3],
    [-0.5 + 2 * t - 1.5 * t2, -5 * t + 4.5 * t2, 0.5 + 4 * t - 4.5 * t2, -t + 1.5 * t2].map((v) => v / scale),
    [2 - 3 * t, -5 + 9 * t, 4 - 9 * t, -1 + 3 * t].map((v) => v / (scale * scale))];
  }

  // Linear ghost values keep the boundary derivative instead of flattening it.
  function value(field, x, y, channel) {
    const nx = field.columns, ny = field.rows, data = field.offsets;
    const ix = clamp(x, 0, nx - 1), iy = clamp(y, 0, ny - 1);
    const jx = x < 0 ? 1 : x >= nx ? nx - 2 : ix;
    const jy = y < 0 ? 1 : y >= ny ? ny - 2 : iy;
    const ax = x === ix ? 1 : 2, ay = y === iy ? 1 : 2;
    return ax * ay * data[(ix + iy * nx) * 2 + channel] +
      (1 - ax) * ay * data[(jx + iy * nx) * 2 + channel] +
      ax * (1 - ay) * data[(ix + jy * nx) * 2 + channel] +
      (1 - ax) * (1 - ay) * data[(jx + jy * nx) * 2 + channel];
  }

  // [offset x/y, first derivatives xx/xy/yx/yy, second derivatives xxx/xxy/xyy/yxx/yxy/yyy].
  // A caller can reuse the output; only geometry arrays travel between workers.
  function evaluate(field, x, y, out = new Float64Array(12)) {
    const gx = clamp(x / field.stepX, 0, field.columns - 1), gy = clamp(y / field.stepY, 0, field.rows - 1);
    const ix = Math.min(field.columns - 2, Math.floor(gx)), iy = Math.min(field.rows - 2, Math.floor(gy));
    const bx = basis(gx - ix, field.stepX), by = basis(gy - iy, field.stepY);
    out.fill(0);
    for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) {
      const a = value(field, ix + u - 1, iy + v - 1, 0), b = value(field, ix + u - 1, iy + v - 1, 1);
      const w = bx[0][u] * by[0][v], dx = bx[1][u] * by[0][v], dy = bx[0][u] * by[1][v];
      const dxx = bx[2][u] * by[0][v], dxy = bx[1][u] * by[1][v], dyy = bx[0][u] * by[2][v];
      out[0] += a * w; out[1] += b * w;
      out[2] += a * dx; out[3] += a * dy; out[4] += b * dx; out[5] += b * dy;
      out[6] += a * dxx; out[7] += a * dxy; out[8] += a * dyy;
      out[9] += b * dxx; out[10] += b * dxy; out[11] += b * dyy;
    }
    return out;
  }

  function at(field, x, y) {
    const v = evaluate(field, x, y);
    return { x: v[0], y: v[1] };
  }

  // Approximate inverse for the source-comparison preview only. Solve it once
  // on a fine native grid, instead of eight spline iterations per camera pixel.
  // Payload sampling always uses the forward curved footprints above.
  async function inverse(field, signal) {
    const width = (field.columns - 1) * field.stepX, height = (field.rows - 1) * field.stepY;
    const columns = Math.ceil(width / 8) + 1, rows = Math.ceil(height / 8) + 1;
    const result = { columns, rows, stepX: width / (columns - 1), stepY: height / (rows - 1),
      offsets: new Float32Array(columns * rows * 2) };
    const evaluated = new Float64Array(12);
    for (let y = 0; y < rows; y++) {
      if (y % 8 === 0) {
        if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
        await pause();
      }
      for (let x = 0; x < columns; x++) {
        const ox = x * result.stepX, oy = y * result.stepY;
        let px = ox, py = oy;
        for (let pass = 0; pass < 8; pass++) {
          evaluate(field, px, py, evaluated);
          px = ox - evaluated[0]; py = oy - evaluated[1];
        }
        const i = (x + y * columns) * 2;
        result.offsets[i] = px - ox; result.offsets[i + 1] = py - oy;
      }
    }
    return result;
  }

  function inverseAt(field, x, y) {
    const gx = clamp(x / field.stepX, 0, field.columns - 1), gy = clamp(y / field.stepY, 0, field.rows - 1);
    const ix = Math.min(field.columns - 2, Math.floor(gx)), iy = Math.min(field.rows - 2, Math.floor(gy));
    const fx = gx - ix, fy = gy - iy, data = field.offsets;
    const a = (ix + iy * field.columns) * 2, b = a + 2, c = a + field.columns * 2, d = c + 2;
    return { x: x + (data[a] * (1 - fx) + data[b] * fx) * (1 - fy) + (data[c] * (1 - fx) + data[d] * fx) * fy,
      y: y + (data[a + 1] * (1 - fx) + data[b + 1] * fx) * (1 - fy) + (data[c + 1] * (1 - fx) + data[d + 1] * fx) * fy };
  }

  const positions = Float64Array.from({ length: SIZE }, (_, i) => (i - (SIZE - 1) / 2) * SAMPLE);
  const window = Float64Array.from(positions, (x) => 0.5 + 0.5 * Math.cos(Math.PI * x / (SIZE * SAMPLE / 2)));
  const waves = (frequencies) => frequencies.map((r) => ({
    real: Float64Array.from(positions, (x) => Math.cos(OMEGA * r * x)),
    imaginary: Float64Array.from(positions, (x) => -Math.sin(OMEGA * r * x))
  }));
  const mainWaves = waves(RATIOS), crossWaves = waves(CROSS);

  function luma(pixels, width, height, x, y, channel) {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const a = (ix + iy * width) * 4, b = (Math.min(width - 1, ix + 1) + iy * width) * 4;
    const c = (ix + Math.min(height - 1, iy + 1) * width) * 4, d = (Math.min(width - 1, ix + 1) + Math.min(height - 1, iy + 1) * width) * 4;
    if (channel !== undefined) return (pixels[a + channel] * (1 - fx) + pixels[b + channel] * fx) * (1 - fy) +
      (pixels[c + channel] * (1 - fx) + pixels[d + channel] * fx) * fy;
    return ((pixels[a] + pixels[a + 1] + pixels[a + 2]) * (1 - fx) + (pixels[b] + pixels[b + 1] + pixels[b + 2]) * fx) * (1 - fy) / 3 +
      ((pixels[c] + pixels[c + 1] + pixels[c + 2]) * (1 - fx) + (pixels[d] + pixels[d + 1] + pixels[d + 2]) * fx) * fy / 3;
  }

  function footprint(pixels, width, height, h, x, y, nx, ny, channel) {
    let sum = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = point(h, x + ((i + 0.5) / nx - 0.5) * SAMPLE, y + ((j + 0.5) / ny - 0.5) * SAMPLE);
      const v = luma(pixels, width, height, p.x, p.y, channel);
      if (!Number.isFinite(v)) return NaN;
      sum += v;
    }
    return sum / (nx * ny);
  }

  function offsetFromTaylor(v, x, y) {
    return { x: v[0] + v[2] * x + v[3] * y + (v[6] * x * x + 2 * v[7] * x * y + v[8] * y * y) / 2,
      y: v[1] + v[4] * x + v[5] * y + (v[9] * x * x + 2 * v[10] * x * y + v[11] * y * y) / 2 };
  }

  // Separable local Fourier search: retain a complex phase as well as strength.
  // Search both spacing and transverse frequency (local rotation/shear).
  function frequency(patch, transpose, energy) {
    const responses = [], lineReal = new Float64Array(SIZE), lineImag = new Float64Array(SIZE);
    for (let f = 0; f < RATIOS.length; f++) {
      const wave = mainWaves[f];
      for (let y = 0; y < SIZE; y++) {
        let real = 0, imaginary = 0;
        for (let x = 0; x < SIZE; x++) {
          const v = patch[transpose ? y + x * SIZE : x + y * SIZE];
          real += v * wave.real[x]; imaginary += v * wave.imaginary[x];
        }
        lineReal[y] = real; lineImag[y] = imaginary;
      }
      for (let c = 0; c < CROSS.length; c++) {
        let real = 0, imaginary = 0;
        const transverse = crossWaves[c];
        for (let y = 0; y < SIZE; y++) {
          real += lineReal[y] * transverse.real[y] - lineImag[y] * transverse.imaginary[y];
          imaginary += lineReal[y] * transverse.imaginary[y] + lineImag[y] * transverse.real[y];
        }
        responses[f * CROSS.length + c] = { real, imaginary, power: real * real + imaginary * imaginary };
      }
    }
    let best = 0;
    for (let i = 1; i < responses.length; i++) if (responses[i].power > responses[best].power) best = i;
    const f = Math.floor(best / CROSS.length), c = best % CROSS.length;
    const peak = (low, middle, high) => clamp(0.5 * (low - high) / Math.min(-1e-12, low - 2 * middle + high), -0.5, 0.5);
    const rf = RATIOS[f] + (f > 0 && f < RATIOS.length - 1 ?
      0.04 * peak(responses[best - CROSS.length].power, responses[best].power, responses[best + CROSS.length].power) : 0);
    const rc = CROSS[c] + (c > 0 && c < CROSS.length - 1 ?
      0.04 * peak(responses[best - 1].power, responses[best].power, responses[best + 1].power) : 0);
    // Re-measure phase at the fitted frequency; the coarse bank is for locating it.
    const realX = Float64Array.from(positions, (x) => Math.cos(OMEGA * rf * x));
    const imagX = Float64Array.from(positions, (x) => -Math.sin(OMEGA * rf * x));
    let real = 0, imaginary = 0;
    for (let y = 0; y < SIZE; y++) {
      let r = 0, im = 0;
      for (let x = 0; x < SIZE; x++) {
        const v = patch[transpose ? y + x * SIZE : x + y * SIZE];
        r += v * realX[x]; im += v * imagX[x];
      }
      const cr = Math.cos(OMEGA * rc * positions[y]), ci = -Math.sin(OMEGA * rc * positions[y]);
      real += r * cr - im * ci; imaginary += r * ci + im * cr;
    }
    const boundary = f === 0 || f === RATIOS.length - 1 || c === 0 || c === CROSS.length - 1;
    return { phase: Math.atan2(imaginary, real), ratio: rf, cross: rc,
      confidence: Math.min(1, Math.hypot(real, imaginary) / Math.max(1, energy)) * (boundary ? 0.4 : 1) };
  }

  function measure(pixels, width, height, geometry, cx, cy, previous, options) {
    const h = geometry.matrix, nativeW = geometry.originalWidth, nativeH = geometry.originalHeight;
    const correction = previous ? evaluate(previous, cx, cy) : new Float64Array(12);
    const centre = point(h, cx + correction[0], cy + correction[1]);
    const px = point(h, cx + correction[0] + SAMPLE, cy + correction[1]);
    const py = point(h, cx + correction[0], cy + correction[1] + SAMPLE);
    const nx = clamp(Math.ceil(Math.hypot(px.x - centre.x, px.y - centre.y)), 1, 4);
    const ny = clamp(Math.ceil(Math.hypot(py.x - centre.x, py.y - centre.y)), 1, 4);
    const samples = new Float64Array(SIZE * SIZE), patch = new Float64Array(samples.length);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const u = positions[x], v = positions[y], qx = cx + u, qy = cy + v;
      if (qx < 0 || qy < 0 || qx > nativeW - 1 || qy > nativeH - 1 ||
        options.reservations.some((r) => qx >= r.x - 1 && qx < r.x + r.width + 1 && qy >= r.y - 1 && qy < r.y + r.height + 1)) {
        samples[x + y * SIZE] = NaN; continue;
      }
      const delta = offsetFromTaylor(correction, u, v);
      samples[x + y * SIZE] = footprint(pixels, width, height, h, qx + delta.x, qy + delta.y, nx, ny, options.channel);
    }
    let count = 0, energy = 0;
    for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
      const i = x + y * SIZE;
      const v = 4 * samples[i] - samples[i - 1] - samples[i + 1] - samples[i - SIZE] - samples[i + SIZE];
      if (!Number.isFinite(v)) continue;
      const weighted = v * window[x] * window[y];
      patch[i] = weighted; energy += Math.abs(weighted); count++;
    }
    if (count < SIZE * SIZE * 0.3 || energy < 128) return null;
    const x = frequency(patch, false, energy), y = frequency(patch, true, energy);
    const confidence = Math.min(x.confidence, y.confidence);
    if (confidence < 0.1) return null;
    return { x: wrap((-3 * Math.PI / 4 + OMEGA * cx - x.phase) / OMEGA),
      y: wrap((-3 * Math.PI / 4 + OMEGA * cy - y.phase) / OMEGA), confidence,
      gradient: [1 - x.ratio, -x.cross, -y.cross, 1 - y.ratio] };
  }

  function anchorGuess(anchors, x, y, step) {
    let sx = 0, sy = 0, weight = 0;
    for (const a of anchors) {
      const w = a.weight / Math.max(step * step / 4, (x - a.x) ** 2 + (y - a.y) ** 2);
      sx += a.dx * w; sy += a.dy * w; weight += w;
    }
    return weight ? { x: sx / weight, y: sy / weight } : { x: 0, y: 0 };
  }

  function neighbours(i, field) {
    const x = i % field.columns, y = Math.floor(i / field.columns), out = [];
    if (x) out.push([i - 1, -field.stepX, 0]);
    if (x + 1 < field.columns) out.push([i + 1, field.stepX, 0]);
    if (y) out.push([i - field.columns, 0, -field.stepY]);
    if (y + 1 < field.rows) out.push([i + field.columns, 0, field.stepY]);
    return out;
  }

  function unwrap(measurements, field, anchors, maximum) {
    const count = measurements.length, accepted = new Uint8Array(count), priority = new Float64Array(count);
    const predictions = new Float64Array(count * 2), offsets = new Float64Array(count * 2);
    // Start near verified marker anchors, not an arbitrary first raster window.
    for (let i = 0; i < count; i++) if (measurements[i]) {
      const x = (i % field.columns) * field.stepX, y = Math.floor(i / field.columns) * field.stepY;
      if (anchors.some((a) => Math.hypot(x - a.x, y - a.y) < STEP * 1.8)) {
        const g = anchorGuess(anchors, x, y, STEP);
        predictions[i * 2] = g.x; predictions[i * 2 + 1] = g.y;
        priority[i] = measurements[i].confidence;
      }
    }
    for (let pass = 0; pass < count; pass++) {
      let best = -1, score = 0;
      for (let i = 0; i < count; i++) if (!accepted[i] && priority[i] > score) { best = i; score = priority[i]; }
      if (best < 0) break;
      const m = measurements[best]; accepted[best] = 1;
      const x = m.x + PERIOD * Math.round((predictions[best * 2] - m.x) / PERIOD);
      const y = m.y + PERIOD * Math.round((predictions[best * 2 + 1] - m.y) / PERIOD);
      if (Math.max(Math.abs(x), Math.abs(y)) > maximum) { m.confidence = 0; continue; }
      offsets[best * 2] = x; offsets[best * 2 + 1] = y;
      for (const [j, dx, dy] of neighbours(best, field)) {
        const n = measurements[j];
        if (!n || accepted[j]) continue;
        const w = Math.min(score, n.confidence) * 0.98;
        if (w <= priority[j]) continue;
        priority[j] = w;
        predictions[j * 2] = x + ((m.gradient[0] + n.gradient[0]) * dx + (m.gradient[1] + n.gradient[1]) * dy) / 2;
        predictions[j * 2 + 1] = y + ((m.gradient[2] + n.gradient[2]) * dx + (m.gradient[3] + n.gradient[3]) * dy) / 2;
      }
    }
    // Downweight inconsistent cycle/branch measurements; never force a weak
    // patch into a raster-order phase continuation or accept contents from it.
    for (let i = 0; i < count; i++) {
      if (!accepted[i]) { if (measurements[i]) measurements[i].confidence = 0; continue; }
      const m = measurements[i];
      let errors = 0, edges = 0;
      for (const [j, dx, dy] of neighbours(i, field)) if (accepted[j] && measurements[j].confidence) {
        const n = measurements[j];
        const ex = offsets[j * 2] - offsets[i * 2] - ((m.gradient[0] + n.gradient[0]) * dx + (m.gradient[1] + n.gradient[1]) * dy) / 2;
        const ey = offsets[j * 2 + 1] - offsets[i * 2 + 1] - ((m.gradient[2] + n.gradient[2]) * dx + (m.gradient[3] + n.gradient[3]) * dy) / 2;
        errors += Math.min(16, ex * ex + ey * ey); edges++;
      }
      if (edges) m.confidence /= 1 + errors / edges;
    }
    return offsets;
  }

  async function fit(field, measurements, data, anchors, check) {
    const count = measurements.length, next = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      const guess = anchorGuess(anchors, (i % field.columns) * field.stepX, Math.floor(i / field.columns) * field.stepY, STEP);
      field.offsets[i * 2] = measurements[i]?.confidence ? data[i * 2] : guess.x;
      field.offsets[i * 2 + 1] = measurements[i]?.confidence ? data[i * 2 + 1] : guess.y;
    }
    const pins = anchors.map((a) => {
      const gx = clamp(a.x / field.stepX, 0, field.columns - 1), gy = clamp(a.y / field.stepY, 0, field.rows - 1);
      const ix = Math.min(field.columns - 2, Math.floor(gx)), iy = Math.min(field.rows - 2, Math.floor(gy)), fx = gx - ix, fy = gy - iy;
      return { a, nodes: [[ix + iy * field.columns, (1 - fx) * (1 - fy)], [ix + 1 + iy * field.columns, fx * (1 - fy)],
        [ix + (iy + 1) * field.columns, (1 - fx) * fy], [ix + 1 + (iy + 1) * field.columns, fx * fy]] };
    });
    for (let pass = 0; pass < 100; pass++) {
      if (pass % 10 === 0) { check(); await pause(); }
      for (let i = 0; i < count; i++) {
        const x = i % field.columns, y = Math.floor(i / field.columns);
        const confidence = measurements[i]?.confidence || 0;
        for (let c = 0; c < 2; c++) {
          const at = (xx, yy) => field.offsets[(clamp(xx, 0, field.columns - 1) + clamp(yy, 0, field.rows - 1) * field.columns) * 2 + c];
          // Discrete thin-plate regularization. It smooths curvature rather than
          // straightening the field between nodes; measurements retain their weight.
          const near = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1);
          const diagonal = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
          const far = at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2);
          const weight = 12 * confidence * confidence, smooth = 0.12;
          const target = (weight * data[i * 2 + c] + smooth * (8 * near - 2 * diagonal - far)) / (weight + 20 * smooth);
          next[i * 2 + c] = 0.4 * target + 0.6 * field.offsets[i * 2 + c];
        }
      }
      field.offsets.set(next);
      for (const { a, nodes } of pins) for (let c = 0; c < 2; c++) {
        const observed = nodes.reduce((sum, [i, w]) => sum + field.offsets[i * 2 + c] * w, 0);
        const denominator = nodes.reduce((sum, [, w]) => sum + w * w, 0);
        const residual = ((c ? a.dy : a.dx) - observed) * 0.75 * clamp(a.weight ?? 1, 0.05, 1);
        for (const [i, w] of nodes) field.offsets[i * 2 + c] += residual * w / denominator;
      }
    }
  }

  async function track(pixels, width, height, geometry, options = {}) {
    const nativeW = geometry.originalWidth, nativeH = geometry.originalHeight;
    const anchors = options.anchors || [];
    if (nativeW < 128 || nativeH < 128 || anchors.length < 3) return null;
    const deadline = Math.min(options.deadline || Infinity, Date.now() + (options.budgetMs || 8000));
    const check = () => {
      if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      if (Date.now() >= deadline) throw { code: "lattice-budget" };
    };
    const columns = Math.ceil((nativeW - 1) / STEP) + 1, rows = Math.ceil((nativeH - 1) / STEP) + 1;
    const field = { kind: "spline", columns, rows, stepX: (nativeW - 1) / (columns - 1), stepY: (nativeH - 1) / (rows - 1),
      offsets: new Float32Array(columns * rows * 2), channel: options.channel };
    const measurements = new Array(columns * rows), maximum = Math.min(48, Math.max(nativeW, nativeH) * 0.04);
    try {
      let previous = options.previous;
      if (!previous && anchors.filter((a) => a.control).length >= 8) {
        // Start with the coarse deformation measured by the marker centres and
        // local axes, instead of sampling a straight plane that may erase phase.
        const coarse = { ...field, offsets: new Float32Array(field.offsets.length) };
        await fit(coarse, new Array(columns * rows), new Float64Array(field.offsets.length), anchors, check);
        const probe = new Float64Array(12);
        let safe = true;
        for (let y = 0; y < rows && safe; y++) for (let x = 0; x < columns; x++) {
          evaluate(coarse, x * field.stepX, y * field.stepY, probe);
          const det = (1 + probe[2]) * (1 + probe[5]) - probe[3] * probe[4];
          if (!Number.isFinite(det) || det < 0.6 || det > 1.6 || Math.max(Math.abs(probe[0]), Math.abs(probe[1])) > maximum ||
            Math.max(...probe.subarray(2, 6).map(Math.abs)) > 0.25) { safe = false; break; }
        }
        if (safe) previous = coarse;
      }
      const residualAnchors = anchors.map((a) => {
        const v = previous ? at(previous, a.x, a.y) : { x: 0, y: 0 };
        return { ...a, dx: a.dx - v.x, dy: a.dy - v.y };
      });
      let good = 0;
      for (let y = 0; y < rows; y++) {
        options.onProgress?.("Following wavelets in the original capture: " + Math.round(y * 100 / rows) + "%…");
        for (let x = 0; x < columns; x++) {
          if (x % 4 === 0) { check(); await pause(); }
          const m = measure(pixels, width, height, geometry, x * field.stepX, y * field.stepY, previous,
            { ...options, reservations: options.reservations || [] });
          measurements[x + y * columns] = m;
          if (m) good++;
        }
      }
      if (good < columns * rows * 0.35) return null;
      const data = unwrap(measurements, field, residualAnchors, maximum);
      await fit(field, measurements, data, residualAnchors, check);
      // Compose native-coordinate displacement fields, never resample a previous
      // corrected image. This data can recreate the result in a fresh worker.
      if (previous) for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const i = (x + y * columns) * 2;
        const prior = at(previous, x * field.stepX + field.offsets[i], y * field.stepY + field.offsets[i + 1]);
        field.offsets[i] += prior.x; field.offsets[i + 1] += prior.y;
      }
      const evaluated = new Float64Array(12);
      // Test nodes and cell interiors; a curved footprint must remain oriented
      // and bounded, not fold or slip several symbols to fit unrelated texture.
      for (let y = 0; y < rows * 2 - 1; y++) for (let x = 0; x < columns * 2 - 1; x++) {
        evaluate(field, x * field.stepX / 2, y * field.stepY / 2, evaluated);
        const determinant = (1 + evaluated[2]) * (1 + evaluated[5]) - evaluated[3] * evaluated[4];
        if (!Number.isFinite(determinant) || determinant < 0.45 || determinant > 1.8 ||
          Math.max(...evaluated.subarray(0, 2).map(Math.abs)) > maximum ||
          Math.max(...evaluated.subarray(2, 6).map(Math.abs)) > 0.35) return null;
      }
      field.measured = good; field.probes = columns * rows;
      field.confidence = measurements.reduce((sum, m) => sum + (m?.confidence || 0), 0) / measurements.length;
      return field;
    } catch (error) {
      if (error?.code === "lattice-budget") {
        options.onProgress?.("Local wavelet tracking reached its time limit; continuing with the other recovery fits…");
        return null;
      }
      throw error;
    }
  }

  root.PixelStowLattice = { track, at, evaluate, inverse, inverseAt };
})(typeof window !== "undefined" ? window : self);
