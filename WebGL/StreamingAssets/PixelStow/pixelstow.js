// Copyright 2026 massivehadron.com ltd.

// Browser PixelStow carriers; PCF1 payload/encryption envelopes are independent.
// Plain text keeps envelope v1/v2 compatibility. Files/tone references use v3.
(function (root) {
  const BLOCK = 4;
  const PREAMBLE_BLOCKS = 72 * 7;
  const MAX_TEXT = 16 * 1024;
  const MAX_BUNDLE = 1024 * 1024;
  const MAX_FILES = 0xFFFF; // Existing PSB1 count is an unsigned 16-bit field.
  const TONE_BYTES = 60;
  const TONE_PERCENTILES = [.02, .08, .18, .32, .5, .68, .82, .92, .98];
  const MAX_FRAMED = MAX_BUNDLE + 80;
  const MAX_BLOCKS = 8 * 1024 * 1024;
  const MAX_PIXELS = 24000000;
  const MAX_INPUT_PIXELS = 32000000;
  const MAX_MARKER_PIXELS = 8000000;
  const HEADER = 20;
  const ENVELOPE = 60;
  const ITERATIONS = 600000;
  const STRENGTHS = [8, 12, 16, 24, 32];
  const WAVELET = [-19, -11, 5, 13, 5, -11, -19];
  const SEED = 0x50434631;
  const MAGIC = 0xC7;
  const V6_MAGIC = 0xCB;
  const V6_NO_EDGE_MARKERS_MAGIC = 0xCA;
  const FLAGS = 1;
  const ONE_PARITY = 2;
  const CARRIER_V1 = 1;
  const CARRIER_V3 = 3;
  const CARRIER_V4 = 4;
  const CARRIER_V5 = 5;
  const CARRIER_V6 = 6;
  const compactCarrier = (version) => version === CARRIER_V5 || version === CARRIER_V6;
  // Compact carriers extend the CRC-protected length word; real frames are at most 1 MiB + 80.
  // Older readers reject the oversized word instead of applying a wrong inverse.
  const CURVED_RANGE_FLAG = 0x80000000;
  const RISK_ALLOCATION_FLAG = 0x40000000;
  const V6_FRAME_LENGTH_MASK = 0x001FFFFF;
  const V6_LUMINANCE_FLAG = 0x00200000;
  const V6_COLOUR_FLAG = 0x80; // Profile-specific: V5 uses this flag for its historical pilot.
  const COLOUR_WAVELET_TINT = 0.8;
  const V6_BRIGHTNESS_SHIFT = 22;
  // Eight stored bits; 0..248 gives uniform steps, exact endpoints and an
  // exactly representable 0.125 adjustable default. 249 identifies the gentle
  // RGB shoulder explicitly; 250..255 remain invalid.
  const V6_BRIGHTNESS_LEVELS = 248;
  const V6_GENTLE_CURVE = 249;
  const DEFAULT_BRIGHTNESS_CURVE = 0.125;
  const RISK_GRID = 16;
  const RISK_TILES = RISK_GRID * RISK_GRID;
  const RISK_MAP_BODY_BYTES = 2 + RISK_TILES / 4;
  const RISK_MAP_BYTES = RISK_MAP_BODY_BYTES + 4;
  const RISK_MAP_COPIES = 3;
  const RISK_MAP_BLOCKS = RISK_MAP_BYTES * 12 * RISK_MAP_COPIES;
  const RISK_SEED = 0x50535236;
  const RISK_WEIGHTS = new Uint8Array([1, 2, 4, 8]);
  const carrierOverhead = (version) => PREAMBLE_BLOCKS + (version === CARRIER_V6 ? RISK_MAP_BLOCKS : 0);
  const SCALE_PILOT_FLAG = 0x80;
  const LEGACY_SCALE_PILOT_AMPLITUDE = 3;
  const SCALE_PILOT = Object.freeze({ period: 256, amplitude: 16,
    tones: Object.freeze([{ k: 2, phase: .2, weight: 1 }, { k: 3, phase: 1.1, weight: .8 }, { k: 5, phase: 2.4, weight: .6 }]) });
  const V4_PAYLOAD_PEAK = 64;
  const V4_MARKER_PEAK = 32;
  const V5_MARKER_PEAK = 32;
  // A native header must not already depend on error correction. This floor
  // matches the reader's per-symbol energy normalization; it is not an optical
  // recovery guarantee.
  const V5_MARKER_NATIVE_FLOOR = 24;
  const REDUNDANCY_UPLIFT_AT_TWO = 0.15;
  const REDUNDANCY_UPLIFT_DENOMINATOR = 1;
  // Scales the whole redundancy curve, including the old 32 ceiling. At 2x the
  // stored amplitude falls from 20 to 16. The caller's floor stays in place.
  const STRENGTH_CURVE_SCALE = 0.8;
  const DEFAULT_QUALITY = 0.8;
  let preferredCarrier = CARRIER_V6;
  let legacyRecovery = false;
  const RECOVERY_CARRIERS = [CARRIER_V6, CARRIER_V5, CARRIER_V4, CARRIER_V3];
  function recoveryVersions(options = {}) {
    if (options.carrierVersion !== undefined)
      return [CARRIER_V1, ...RECOVERY_CARRIERS].includes(options.carrierVersion) ? [options.carrierVersion] : [];
    return (options.includeLegacy ?? legacyRecovery) ? [...RECOVERY_CARRIERS, CARRIER_V1] : [CARRIER_V6];
  }
  function recoveryOptions(options) {
    const selected = recoveryVersions(options);
    return { ...options, includeLegacy: options.includeLegacy ?? legacyRecovery,
      // Opt-in only: the strong-fit shortcut can cost more when its first
      // payload grid fails. Ordinary capture keeps the proven refinement path.
      earlyPayload: options.earlyPayload ?? (new URLSearchParams(root.location?.search || "").get("earlyPayload") === "1"),
      seed: selected.includes(options.seed?.carrierVersion) ? options.seed : undefined,
      searchState: !options.searchState?.seed || selected.includes(options.searchState.seed.carrierVersion) ? options.searchState : undefined };
  }
  const codecScriptUrl = typeof document !== "undefined" ? document.currentScript?.src : null;
  // Store geometry and, for photographs, the rectified native pixel grid. Payload
  // bytes are never cached; every later read still verifies the carrier/frame.
  const visualMappings = new WeakMap();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) >>> 0 : (value >>> 1);
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  const WORD_BITS = (() => {
    const table = new Uint8Array(256 * 12);
    for (let value = 0; value < 256; value++) {
      const offset = value * 12;
      const d0 = (value >> 7) & 1;
      const d1 = (value >> 6) & 1;
      const d2 = (value >> 5) & 1;
      const d3 = (value >> 4) & 1;
      const d4 = (value >> 3) & 1;
      const d5 = (value >> 2) & 1;
      const d6 = (value >> 1) & 1;
      const d7 = value & 1;
      table[offset] = d0;
      table[offset + 1] = d1;
      table[offset + 2] = d2;
      table[offset + 3] = d3;
      table[offset + 4] = d4;
      table[offset + 5] = d5;
      table[offset + 6] = d6;
      table[offset + 7] = d7;
      table[offset + 8] = d0 ^ d1 ^ d3 ^ d4 ^ d6;
      table[offset + 9] = d0 ^ d2 ^ d3 ^ d5 ^ d6;
      table[offset + 10] = d1 ^ d2 ^ d3 ^ d7;
      table[offset + 11] = d4 ^ d5 ^ d6 ^ d7;
    }
    return table;
  })();

  const NOISE_KERNELS = (() => {
    const kernels = [];
    for (let v = 0; v < 4; v++) {
      for (let u = 0; u < 4; u++) {
        if ((v & 1) === (u & 1)) continue;
        const kernel = new Float64Array(16);
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            kernel[x + y * 4] = (u === 0 ? 0.5 : Math.sqrt(0.5)) *
              (v === 0 ? 0.5 : Math.sqrt(0.5)) *
              Math.cos(Math.PI * u * (x + 0.5) / 4) *
              Math.cos(Math.PI * v * (y + 0.5) / 4);
          }
        }
        kernels.push(kernel);
      }
    }
    return kernels;
  })();

  function frameError(message) {
    const error = new Error(message);
    error.code = "frame";
    return error;
  }

  function recordReadFailure(trace, candidate) {
    if (!trace) return;
    const stages = { marker: 0, markers: 1, dimensions: 2, wavelets: 2, header: 3, allocation: 4, payload: 5, checksum: 6 };
    const current = stages[trace.stage] ?? -1, next = stages[candidate.stage] ?? -1;
    if (next < current) return;
    // Across candidate phases/channels report the furthest stage reached, then
    // the least damaged attempt. Retain counts only, never decoded bytes.
    if (next === current && Number.isFinite(trace.corrections) &&
      trace.corrections / trace.framedBytes <= candidate.corrections / candidate.framedBytes) return;
    Object.assign(trace, candidate);
  }

  function describeReadFailure(result) {
    const failure = result?.failure;
    const count = result?.markers?.length || result?.geometry?.markerCount || 0;
    const markers = count ? count + "/4 markers found. " : "";
    if (failure?.stage === "marker") return "No native V6 marker found; payload reading was not started.";
    if (failure?.stage === "dimensions") return "Marker found, but image dimensions have changed; geometric recovery is needed.";
    if (failure?.stage === "allocation") return "Wavelet header read, but the protected repetition map could not be recovered; payload reading was not reached.";
    if (["payload", "checksum"].includes(failure?.stage)) {
      const measured = Number.isInteger(failure.corrections) && Number.isInteger(failure.framedBytes) && failure.framedBytes > 0;
      const corrections = measured ? " " + failure.corrections.toLocaleString("en-GB") + "/" + failure.framedBytes.toLocaleString("en-GB") + " bytes needed parity correction." : "";
      return "Wavelet header read; " + (failure.stage === "checksum" ? "payload checksum failed after error correction." : "payload still invalid after error correction.") + corrections;
    }
    if (failure?.stage === "header") return "Wavelet header read, but a complete payload could not be read.";
    if (result?.geometry || count || failure?.stage === "wavelets")
      return markers + "Could not resolve a valid wavelet header; payload error correction was not reached.";
    return "No usable marker geometry found; payload reading was not reached.";
  }

  function yieldNow() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function checkCancelled(signal) {
    if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
  }

  function roundHalfToEven(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return (floor % 2 === 0) ? floor : floor + 1;
  }

  function crc32(data, offset, count) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < count; i++) {
      crc = (CRC_TABLE[(crc ^ data[offset + i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function writeU32(buffer, offset, value) {
    buffer[offset] = value & 0xFF;
    buffer[offset + 1] = (value >>> 8) & 0xFF;
    buffer[offset + 2] = (value >>> 16) & 0xFF;
    buffer[offset + 3] = (value >>> 24) & 0xFF;
  }

  function readU32(buffer, offset) {
    return ((buffer[offset] |
      (buffer[offset + 1] << 8) |
      (buffer[offset + 2] << 16) |
      (buffer[offset + 3] << 24)) >>> 0);
  }

  function readU32be(buffer, offset) {
    return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
  }

  function xorshift32(state) {
    state = state >>> 0;
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  }

  function scramble(data, seed) {
    let state = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
      state = xorshift32(state);
      data[i] ^= state & 0xFF;
    }
  }

  function strictUtf8(text) {
    if (typeof text !== "string") throw new Error("The message must be text.");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0xD800 || code > 0xDFFF) continue;
      if (code <= 0xDBFF && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          i++;
          continue;
        }
      }
      throw new Error("The message is not valid text.");
    }
    return encoder.encode(text);
  }

  function decodeUtf8(bytes) {
    try {
      return decoder.decode(bytes);
    } catch {
      throw frameError("The fingerprint text is not valid.");
    }
  }

  function bytesEqual(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
  }

  function assertImage(pixels, width, height, limit = MAX_INPUT_PIXELS) {
    if (!pixels || width < 1 || height < 1 || width * height * 4 !== pixels.length) {
      throw new Error("The image dimensions are invalid.");
    }
    if (width < BLOCK || height < BLOCK) throw new Error("Use an image at least 4 by 4 pixels.");
    if (width * height > limit) throw new Error("This image exceeds the " + (limit / 1000000) + " megapixel " +
      (limit === MAX_PIXELS ? "encoding" : "photo input") + " limit.");
    const blocks = Math.floor(width / BLOCK) * Math.floor(height / BLOCK);
    if (blocks > MAX_BLOCKS) throw new Error("This image is too large for the browser tool.");
    return blocks;
  }

  function estimateBytes(width, height) {
    return Math.min(MAX_TEXT, estimatePayloadBytes(width, height));
  }

  function estimatePayloadBytes(width, height, passwordProtected = false, carrierVersion = preferredCarrier, options = {}) {
    if (width < BLOCK || height < BLOCK || width * height > MAX_PIXELS) return 0;
    const profile = locatorProfile(carrierVersion);
    if (compactCarrier(carrierVersion) && !locatorFits(width, height, carrierVersion)) return 0;
    const blocks = Math.floor(width / BLOCK) * Math.floor(height / BLOCK) -
      (profile && locatorFits(width, height, carrierVersion) ? locatorArea(carrierVersion, carrierVersion === CARRIER_V6 ? options.edgeMarkers === false ? 0 : 4 : 6) / 16 : 0);
    const overhead = carrierOverhead(carrierVersion);
    if (blocks <= overhead || blocks > MAX_BLOCKS) return 0;
    let framed = Math.floor((blocks - overhead) / 9);
    if (framed > MAX_FRAMED) framed = MAX_FRAMED;
    return Math.max(0, Math.min(MAX_BUNDLE, framed - HEADER - (passwordProtected ? ENVELOPE : 0)));
  }

  function attachmentMetadata(name, type) {
    const nameBytes = strictUtf8(name);
    const typeBytes = strictUtf8(type);
    if (!nameBytes.length || nameBytes.length > 255 || /[\x00-\x1f\x7f/\\:]/.test(name) || name === "." || name === "..") {
      throw frameError("Attachment names must be simple filenames of at most 255 UTF-8 bytes.");
    }
    if (!typeBytes.length || typeBytes.length > 127 || !/^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+(?:;[ -~]*)?$/i.test(type)) {
      throw frameError("Invalid attachment media type.");
    }
    return { nameBytes, typeBytes };
  }

  const toneLuma = (r, g, b) => .2126 * r + .7152 * g + .0722 * b;

  function measureTone(pixels, width, height) {
    // Keep the tone sampler's conservative windows fixed. Changing diagnostic
    // marker dimensions must not change the established colour calibration.
    const reserved = locatorFits(width, height, CARRIER_V6) ? reservedLocators(width, height, CARRIER_V6, 6) : [];
    const cells = Array.from({ length: 16 }, () => ({ r: 0, g: 0, b: 0, count: 0 }));
    const samples = [], luminance = [];
    let chroma = 0, transparent = 0, attempted = 0;
    // Complete aligned 4x4 averages suppress the carrier and keep work bounded
    // regardless of capture size. Skip the guide border and repaired markers.
    for (let gy = 0; gy < 64; gy++) for (let gx = 0; gx < 64; gx++) {
      const x = Math.min(width - 4, Math.floor((gx + .5) * width / 256) * 4);
      const y = Math.min(height - 4, Math.floor((gy + .5) * height / 256) * 4);
      if (x < 8 || y < 8 || x + 4 > width - 8 || y + 4 > height - 8 ||
        reserved.some(p => x < p.x + p.width && x + 4 > p.x && y < p.y + p.height && y + 4 > p.y)) continue;
      attempted++;
      let r = 0, g = 0, b = 0, alpha = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const i = (x + dx + (y + dy) * width) * 4, a = pixels[i + 3] / 255;
        r += pixels[i] * a; g += pixels[i + 1] * a; b += pixels[i + 2] * a; alpha += a;
      }
      if (alpha < 15.8) { transparent++; continue; }
      r /= alpha; g /= alpha; b /= alpha;
      const luma = toneLuma(r, g, b), u = r - luma, v = b - luma;
      const tile = Math.floor(gx / 16) + 4 * Math.floor(gy / 16), cell = cells[tile];
      cell.r += r; cell.g += g; cell.b += b; cell.count++;
      samples.push({ u, v });
      luminance.push(luma); chroma += Math.hypot(u, v);
    }
    if (samples.length < 128 || transparent > attempted * .02 || cells.some(c => !c.count)) return null;
    for (const cell of cells) { cell.r /= cell.count; cell.g /= cell.count; cell.b /= cell.count; }
    luminance.sort((a, b) => a - b);
    const quantiles = TONE_PERCENTILES.map(p => {
      const at = p * (luminance.length - 1), low = Math.floor(at), fraction = at - low;
      return luminance[low] * (1 - fraction) + luminance[Math.min(low + 1, luminance.length - 1)] * fraction;
    });
    return { cells, samples, quantiles, chroma: chroma / samples.length };
  }

  function createToneReference(pixels, width, height) {
    assertImage(pixels, width, height);
    // The target is measured in pristine source space, before range mapping,
    // guides or wavelets. Recovery must compare only after undoing those stages.
    const measured = measureTone(pixels, width, height);
    if (!measured) return null;
    const profile = new Uint8Array(TONE_BYTES);
    profile[0] = 1;
    profile.set(measured.quantiles.map(clampChannel), 2);
    profile[11] = clampChannel(measured.chroma);
    measured.cells.forEach((cell, i) => profile.set([cell.r, cell.g, cell.b].map(clampChannel), 12 + i * 3));
    return profile;
  }

  function toneCurve(measured, profile) {
    const knots = [];
    measured.quantiles.forEach((value, i) => {
      const target = value + clampRange(profile[i + 2] - value, -56, 56);
      const previous = knots[knots.length - 1];
      if (!previous || value - previous.x >= 4) knots.push({ x: value, y: target });
    });
    const curve = new Float64Array(256);
    let segment = 0;
    for (let value = 0; value < 256; value++) {
      while (segment + 2 < knots.length && value > knots[segment + 1].x) segment++;
      const a = knots[segment], b = knots[Math.min(segment + 1, knots.length - 1)];
      const slope = a === b ? 1 : clampRange((b.y - a.y) / (b.x - a.x), .4, 2.5);
      const mapped = clampRange(a.y + (value - a.x) * slope, Math.max(0, value - 56), Math.min(255, value + 56));
      // Preserve ordering even when a slope/delta limit changes at a knot.
      curve[value] = value ? clampRange(mapped, curve[value - 1], Math.min(255, curve[value - 1] + 2.5)) : mapped;
    }
    return curve;
  }

  async function restoreTone(pixels, width, height, profile, signal) {
    validateToneReference(profile);
    const measured = measureTone(pixels, width, height);
    if (!measured) return pixels;
    const toneError = measured.quantiles.reduce((sum, v, i) => sum + Math.abs(v - profile[i + 2]), 0) / 9;
    const colourError = measured.cells.reduce((sum, c, i) => sum + Math.abs(c.r - profile[12 + i * 3]) +
      Math.abs(c.g - profile[13 + i * 3]) + Math.abs(c.b - profile[14 + i * 3]), 0) / 48;
    // A tiny reference cannot distinguish small camera/extraction differences
    // from a real cast. Do not manufacture a correction for an already close image.
    if (toneError < 4 && colourError < 5 && Math.abs(measured.chroma - profile[11]) < 4) {
      if (toneError < 2.5 && colourError < 2.5) return pixels;
      // Small exposure/cast changes can sit below the old deadband. Require
      // the corresponding cells to support a common brightness transform or
      // chroma bias; unrelated native quantisation errors stay untouched.
      const residuals = measured.cells.map((cell, i) => {
        const y = toneLuma(cell.r, cell.g, cell.b), r = profile[12 + i * 3], g = profile[13 + i * 3], b = profile[14 + i * 3];
        const targetY = toneLuma(r, g, b);
        return { y, dy: targetY - y, u: cell.r - y - (r - targetY), v: cell.b - y - (b - targetY) };
      });
      const u = residuals.reduce((sum, p) => sum + p.u, 0) / residuals.length;
      const v = residuals.reduce((sum, p) => sum + p.v, 0) / residuals.length;
      const variation = Math.sqrt(residuals.reduce((sum, p) => sum + (p.u - u) ** 2 + (p.v - v) ** 2, 0) / residuals.length);
      const meanY = residuals.reduce((sum, p) => sum + p.y, 0) / residuals.length;
      const meanDelta = residuals.reduce((sum, p) => sum + p.dy, 0) / residuals.length;
      const varianceY = residuals.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0);
      const slope = residuals.reduce((sum, p) => sum + (p.y - meanY) * (p.dy - meanDelta), 0) / Math.max(1, varianceY);
      const change = Math.sqrt(residuals.reduce((sum, p) => sum + p.dy ** 2, 0) / residuals.length);
      const fitError = Math.sqrt(residuals.reduce((sum, p) => sum + (p.dy - meanDelta - slope * (p.y - meanY)) ** 2, 0) / residuals.length);
      const consistentTone = change > 2.5 && fitError < Math.min(2, change * .5);
      if (!consistentTone && Math.hypot(u, v) <= Math.max(2.5, variation)) return pixels;
    }
    const curve = toneCurve(measured, profile);
    const lookup = value => {
      value = clampRange(value, 0, 255);
      const low = Math.floor(value), fraction = value - low;
      return curve[low] * (1 - fraction) + curve[Math.min(255, low + 1)] * fraction;
    };
    const pairs = measured.cells.map((cell, i) => {
      const y = toneLuma(cell.r, cell.g, cell.b), r = profile[12 + i * 3], g = profile[13 + i * 3], b = profile[14 + i * 3];
      const targetY = toneLuma(r, g, b);
      return { y, targetY, u: cell.r - y, v: cell.b - y, tu: r - targetY, tv: b - targetY };
    });
    // Histogram matching alone may fight the corresponding reference colours
    // after a camera changes local contrast. Fit its amount against those 16
    // independent spatial measurements, with an identity prior for small errors.
    let toneBlend = 0;
    for (let pass = 0; pass < 2; pass++) {
      let numerator = 0, denominator = 0;
      for (const p of pairs) {
        const delta = lookup(p.y) - p.y;
        const weight = pass ? Math.min(1, 12 / Math.max(1, Math.abs(p.y + toneBlend * delta - p.targetY))) : 1;
        numerator += weight * delta * (p.targetY - p.y);
        denominator += weight * (delta * delta + 9);
      }
      toneBlend = clampRange(numerator / denominator, 0, 1);
    }
    // Fit the overall brightness correction independently of the detail cap.
    // A flat/clipped histogram tail must not halve an otherwise supported
    // exposure correction across the entire image. Limit local detail below.
    for (const p of pairs)
      p.weight = Math.min(1, 24 / Math.max(1, Math.abs(p.y + toneBlend * (lookup(p.y) - p.y) - p.targetY)));
    let matrix = [1, 0, 0, 1], bias = [0, 0];
    // A regularised two-channel chroma fit supports casts and hue shifts without
    // letting a nearly monochrome picture invent an unconstrained colour matrix.
    for (let pass = 0; pass < 2; pass++) {
      let total = 0, mu = 0, mv = 0, mtu = 0, mtv = 0;
      for (const p of pairs) {
        p.w = p.weight * (pass ? Math.min(1, 20 / Math.max(1, Math.hypot(
          matrix[0] * p.u + matrix[1] * p.v + bias[0] - p.tu,
          matrix[2] * p.u + matrix[3] * p.v + bias[1] - p.tv))) : 1);
        total += p.w; mu += p.w * p.u; mv += p.w * p.v; mtu += p.w * p.tu; mtv += p.w * p.tv;
      }
      mu /= total; mv /= total; mtu /= total; mtv /= total;
      let uu = 0, uv = 0, vv = 0, utu = 0, vtu = 0, utv = 0, vtv = 0;
      for (const p of pairs) {
        const u = p.u - mu, v = p.v - mv, tu = p.tu - mtu, tv = p.tv - mtv, w = p.w / total;
        uu += w * u * u; uv += w * u * v; vv += w * v * v;
        utu += w * u * tu; vtu += w * v * tu; utv += w * u * tv; vtv += w * v * tv;
      }
      const ridge = Math.max(36, (uu + vv) * .12), a = uu + ridge, d = vv + ridge, det = a * d - uv * uv;
      matrix = [clampRange(((utu + ridge) * d - vtu * uv) / det, .5, 2),
        clampRange((vtu * a - (utu + ridge) * uv) / det, -.5, .5),
        clampRange((utv * d - (vtv + ridge) * uv) / det, -.5, .5),
        clampRange(((vtv + ridge) * a - utv * uv) / det, .5, 2)];
      bias = [clampRange(mtu - matrix[0] * mu - matrix[1] * mv, -32, 32),
        clampRange(mtv - matrix[2] * mu - matrix[3] * mv, -32, 32)];
    }
    let chroma = 0;
    for (const s of measured.samples) chroma += Math.hypot(matrix[0] * s.u + matrix[1] * s.v + bias[0],
      matrix[2] * s.u + matrix[3] * s.v + bias[1]);
    // Residual coloured texture can inflate the fine-scale chroma magnitude.
    // Do not turn that into a global desaturation on top of the colour fit:
    // the corresponding spatial colours must support the same adjustment.
    let spatialChroma = 0, targetChroma = 0, colourWeight = 0;
    for (const p of pairs) {
      spatialChroma += p.weight * Math.hypot(matrix[0] * p.u + matrix[1] * p.v + bias[0],
        matrix[2] * p.u + matrix[3] * p.v + bias[1]);
      targetChroma += p.weight * Math.hypot(p.tu, p.tv);
      colourWeight += p.weight;
    }
    spatialChroma /= colourWeight; targetChroma /= colourWeight;
    const supportedRatio = (target, observed) => observed > target + 2
      ? clampRange((target + 2) / Math.max(3, observed), .65, 1)
      : target > observed + 2 ? clampRange((target - 2) / Math.max(3, observed), 1, 1.6) : 1;
    const fineRatio = profile[11] < 3 ? 1 : supportedRatio(profile[11], chroma / measured.samples.length);
    const spatialRatio = supportedRatio(targetChroma, spatialChroma);
    const saturation = fineRatio < 1 && spatialRatio < 1 ? Math.max(fineRatio, spatialRatio)
      : fineRatio > 1 && spatialRatio > 1 ? Math.min(fineRatio, spatialRatio) : 1;
    // Saturation and matrix gain previously stacked unchecked. Validate their
    // combined adjustment against the reference, then constrain its distance
    // from identity so a camera-specific fit cannot greatly amplify colour noise.
    let chromaNumerator = 0, chromaDenominator = 0;
    for (const p of pairs) {
      const du = saturation * (matrix[0] * p.u + matrix[1] * p.v + bias[0]) - p.u;
      const dv = saturation * (matrix[2] * p.u + matrix[3] * p.v + bias[1]) - p.v;
      chromaNumerator += p.weight * (du * (p.tu - p.u) + dv * (p.tv - p.v));
      chromaDenominator += p.weight * (du * du + dv * dv + 18);
    }
    const chromaGainChange = Math.hypot(saturation * matrix[0] - 1, saturation * matrix[1],
      saturation * matrix[2], saturation * matrix[3] - 1);
    const chromaBlend = Math.min(clampRange(chromaNumerator / chromaDenominator, 0, 1),
      .5 / Math.max(.5, chromaGainChange));
    if (toneBlend < .001 && chromaBlend < .001) return pixels;
    const output = pixels.slice();
    for (let y = 0; y < height; y++) {
      if ((y & 31) === 31) { await yieldNow(); checkCancelled(signal); }
      for (let x = 0; x < width; x++) {
        const i = (x + y * width) * 4;
        if (!pixels[i + 3]) continue;
        const luma = toneLuma(pixels[i], pixels[i + 1], pixels[i + 2]);
        let target = luma;
        if (toneBlend >= .001) {
          // Correct a smooth RGB-guided brightness base fully, while retaining
          // the 0.5..1.5x limit on fine detail instead of on the whole curve.
          // The colour fit and its combined-gain safeguards remain separate.
          let total = 0, brightness = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
            const j = (x + dx + (y + dy) * width) * 4;
            const dr = pixels[j] - pixels[i], dg = pixels[j + 1] - pixels[i + 1], db = pixels[j + 2] - pixels[i + 2];
            const distance = (dr * dr + dg * dg + db * db) / (3 * 16 * 16);
            const weight = (dx ? 1 : 2) * (dy ? 1 : 2) * pixels[j + 3] / 255 / (1 + distance * distance);
            total += weight; brightness += weight * toneLuma(pixels[j], pixels[j + 1], pixels[j + 2]);
          }
          const base = brightness / total, mappedBase = base + toneBlend * (lookup(base) - base), detail = luma - base;
          const mappedDetail = luma + toneBlend * (lookup(luma) - luma) - mappedBase;
          target = mappedBase + clampRange(mappedDetail, Math.min(.5 * detail, 1.5 * detail), Math.max(.5 * detail, 1.5 * detail));
        }
        const u = pixels[i] - luma, v = pixels[i + 2] - luma;
        const r = u + chromaBlend * (saturation * (matrix[0] * u + matrix[1] * v + bias[0]) - u);
        const b = v + chromaBlend * (saturation * (matrix[2] * u + matrix[3] * v + bias[1]) - v);
        const g = -(.2126 * r + .0722 * b) / .7152;
        // Give the fitted colour room before changing brightness. A saturated
        // colour should not become grey just to meet a histogram luminance.
        // Reduce chroma only when its span cannot fit any legal brightness.
        const low = Math.min(r, g, b), high = Math.max(r, g, b);
        const gamut = Math.min(1, 255 / Math.max(1, high - low));
        const brightness = clampRange(target, -gamut * low, 255 - gamut * high);
        output[i] = clampChannel(brightness + gamut * r);
        output[i + 1] = clampChannel(brightness + gamut * g);
        output[i + 2] = clampChannel(brightness + gamut * b);
      }
    }
    checkCancelled(signal);
    return output;
  }

  function validateToneReference(profile) {
    if (!(profile instanceof Uint8Array) || !((profile[0] === 1 && profile[1] === 0 && profile.length === TONE_BYTES) ||
      (profile[0] === 2 && profile[1] >= 6 && profile[1] <= 24 && profile.length === TONE_BYTES + profile[1] * 3)))
      throw frameError("Unsupported source tone reference.");
    for (let i = 3; i < 11; i++) if (profile[i] < profile[i - 1]) throw frameError("Invalid source tone percentiles.");
    return profile;
  }

  // PSB1 flag 1 inserts a versioned tone reference before the text. A reference
  // uses the same frame checksum, parity, repetition and encryption as content.
  function packBundle(text, attachments, toneProfile = null) {
    const textBytes = strictUtf8(text);
    if (textBytes.length > MAX_TEXT) throw new Error("The message is longer than 16 KiB.");
    if (toneProfile) validateToneReference(toneProfile);
    if (!Array.isArray(attachments) || (!attachments.length && !toneProfile)) throw new Error("Add at least one attachment.");
    if (attachments.length > MAX_FILES) throw new Error("The attachment count exceeds the format's 65,535-file range.");
    let size = 12 + (toneProfile?.length || 0) + textBytes.length;
    const entries = attachments.map((file) => {
      if (!(file.bytes instanceof Uint8Array)) throw new Error("Attachment data must be bytes.");
      const metadata = attachmentMetadata(file.name, file.type || "application/octet-stream");
      size += 8 + metadata.nameBytes.length + metadata.typeBytes.length + file.bytes.length;
      if (size > MAX_BUNDLE) throw new Error("The message and attachments exceed the 1 MiB payload limit.");
      return { ...metadata, bytes: file.bytes };
    });
    const bundle = new Uint8Array(size);
    const view = new DataView(bundle.buffer);
    bundle.set([0x50, 0x53, 0x42, 0x31, 1, toneProfile ? 1 : 0]);
    view.setUint16(6, entries.length, true);
    view.setUint32(8, textBytes.length, true);
    if (toneProfile) bundle.set(toneProfile, 12);
    const textStart = 12 + (toneProfile?.length || 0);
    bundle.set(textBytes, textStart);
    let cursor = textStart + textBytes.length;
    for (const file of entries) {
      view.setUint16(cursor, file.nameBytes.length, true);
      view.setUint16(cursor + 2, file.typeBytes.length, true);
      view.setUint32(cursor + 4, file.bytes.length, true);
      cursor += 8;
      for (const bytes of [file.nameBytes, file.typeBytes, file.bytes]) {
        bundle.set(bytes, cursor);
        cursor += bytes.length;
      }
    }
    return bundle;
  }

  function unpackBundle(bundle) {
    if (bundle.length < 12 || bundle.length > MAX_BUNDLE ||
      !bytesEqual(bundle.subarray(0, 5), new Uint8Array([0x50, 0x53, 0x42, 0x31, 1])) || bundle[5] > 1) {
      throw frameError("Unsupported attachment bundle.");
    }
    const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
    const count = view.getUint16(6, true);
    const textLength = view.getUint32(8, true);
    let referenceBytes = 0;
    if (bundle[5] & 1) {
      if (bundle.length < 12 + TONE_BYTES) throw frameError("Truncated source tone reference.");
      referenceBytes = TONE_BYTES + (bundle[12] === 2 ? bundle[13] * 3 : 0);
    }
    const textStart = 12 + referenceBytes;
    // Every entry needs an eight-byte header, a name and at least "a/b" as its type.
    if ((!count && !(bundle[5] & 1)) || (!count && !textLength) || textLength > MAX_TEXT || textStart + textLength + count * 12 > bundle.length) {
      throw frameError("Invalid attachment bundle lengths.");
    }
    const toneProfile = bundle[5] & 1 ? validateToneReference(bundle.slice(12, textStart)) : null;
    const text = decodeUtf8(bundle.subarray(textStart, textStart + textLength));
    let cursor = textStart + textLength;
    const attachments = [];
    for (let i = 0; i < count; i++) {
      if (cursor + 8 > bundle.length) throw frameError("Truncated attachment header.");
      const nameLength = view.getUint16(cursor, true);
      const typeLength = view.getUint16(cursor + 2, true);
      const dataLength = view.getUint32(cursor + 4, true);
      cursor += 8;
      if (nameLength < 1 || nameLength > 255 || typeLength < 1 || typeLength > 127 ||
        cursor + nameLength + typeLength + dataLength > bundle.length) {
        throw frameError("Invalid attachment lengths.");
      }
      const name = decodeUtf8(bundle.subarray(cursor, cursor += nameLength));
      const type = decodeUtf8(bundle.subarray(cursor, cursor += typeLength));
      attachmentMetadata(name, type);
      const bytes = bundle.slice(cursor, cursor += dataLength);
      attachments.push({ name, type, bytes });
    }
    if (cursor !== bundle.length) throw frameError("Unexpected attachment bundle data.");
    return { text, attachments, ...(toneProfile ? { toneProfile } : {}) };
  }

  function payloadSize(text, attachments = [], toneProfile = null) {
    return attachments.length || toneProfile ? packBundle(text, attachments, toneProfile).length : strictUtf8(text).length;
  }

  function repetitionBudget(payloadBlocks, framedBytes, bitsPerByte) {
    const codedBits = framedBytes * bitsPerByte;
    return { repetitionRatio: payloadBlocks / codedBits, copies: Math.floor(payloadBlocks / codedBits),
      parityBits: bitsPerByte - 8, framedBytes, fits: codedBits <= payloadBlocks };
  }

  function payloadCodeBits(payloadBlocks, framedBytes, version) {
    // V6 spends spare area on repeats once two copies fit with full parity.
    // Below that boundary favour stronger parity
    // when a complete 12-bit codeword stream still fits. Older writers keep
    // their original parity choice; readers follow the stored header flag.
    if (version === CARRIER_V6 && payloadBlocks >= framedBytes * 12 * 2) return 9;
    if (payloadBlocks >= framedBytes * 12) return 12;
    return payloadBlocks >= framedBytes * 9 ? 9 : 0;
  }

  async function estimatePayloadFrame(content, passwordProtected = false) {
    const { text = "", attachments = [], toneProfile = null } = content, bundle = attachments.length > 0 || Boolean(toneProfile);
    if (!text && !attachments.length) return null;
    const plain = bundle ? packBundle(text, attachments, toneProfile) : strictUtf8(text);
    try {
      if (!plain.length) return null;
      // Both paths compress before framing/encryption. The encrypted envelope
      // then adds fixed overhead; no password or encryption is needed here.
      const compressed = await deflateRaw(plain);
      const framedBytes = HEADER + (passwordProtected ? ENVELOPE : 0) + Math.min(plain.length, compressed.length || Infinity);
      compressed.fill(0);
      return { framedBytes };
    } finally { plain.fill(0); }
  }

  function repetitionForFrame(width, height, framedBytes, version = preferredCarrier, options = {}) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < BLOCK || height < BLOCK ||
      width * height > MAX_PIXELS || !Number.isSafeInteger(framedBytes) || framedBytes < HEADER || framedBytes > MAX_FRAMED) return null;
    if (locatorProfile(version) && !locatorFits(width, height, version)) return null;
    if (![CARRIER_V1, ...RECOVERY_CARRIERS].includes(version)) return null;
    const payloadBlocks = Math.floor(width / BLOCK) * Math.floor(height / BLOCK) - carrierOverhead(version) -
      (locatorProfile(version) ? locatorArea(version, version === CARRIER_V6 ? options.edgeMarkers === false ? 0 : 4 : 6) / 16 : 0);
    const bitsPerByte = payloadCodeBits(payloadBlocks, framedBytes, version) || 9;
    return { ...repetitionBudget(Math.max(0, payloadBlocks), framedBytes, bitsPerByte), carrierVersion: version, width, height,
      allocationBlocks: version === CARRIER_V6 ? RISK_MAP_BLOCKS : 0 };
  }

  async function estimateRepetition(width, height, content, passwordProtected = false, options = {}) {
    if (compactCarrier(preferredCarrier) && !locatorFits(width, height, preferredCarrier)) return null;
    const frame = await estimatePayloadFrame(content, passwordProtected);
    if (!frame) return null;
    const version = locatorProfile(preferredCarrier) && locatorFits(width, height, preferredCarrier) ? preferredCarrier : CARRIER_V1;
    return repetitionForFrame(width, height, frame.framedBytes, version, options);
  }

  function payloadsEqual(left, right) {
    if (left.text !== right.text || left.attachments.length !== right.attachments.length) return false;
    return left.attachments.every((file, i) => file.name === right.attachments[i].name &&
      file.type === right.attachments[i].type && bytesEqual(file.bytes, right.attachments[i].bytes));
  }

  function frameChecksum(header, payload) {
    const checked = new Uint8Array(16 + payload.length);
    checked.set(header.subarray(0, 16), 0);
    checked.set(payload, 16);
    return crc32(checked, 0, checked.length);
  }

  async function packFrame(payload, strength, passwordProtected, bundle = false) {
    const limit = bundle ? MAX_BUNDLE : MAX_TEXT;
    const max = passwordProtected ? ENVELOPE + limit : limit;
    if (payload.length < 1 || payload.length > max) throw new Error("The message is too long to encode.");
    if (passwordProtected) validateEnvelope(payload, bundle);
    // Public text is DEFLATE-compressed when that is smaller, matching the desktop writer.
    // The checksum and declared length always cover the uncompressed bytes.
    let body = payload;
    let compressed = 0;
    if (!passwordProtected) {
      const deflated = await deflateRaw(payload);
      if (deflated.length > 0 && deflated.length < payload.length) {
        body = deflated;
        compressed = 1;
      }
    }
    const frame = new Uint8Array(HEADER + body.length);
    frame.set([0x50, 0x43, 0x46, 0x31], 0);
    frame[4] = bundle ? 3 : passwordProtected ? 2 : 1;
    frame[5] = bundle ? (passwordProtected ? 4 : 3) : passwordProtected ? 2 : 1;
    frame[6] = compressed;
    frame[7] = strength;
    writeU32(frame, 8, payload.length);
    writeU32(frame, 12, body.length);
    writeU32(frame, 16, frameChecksum(frame, payload));
    frame.set(body, HEADER);
    scramble(frame, SEED);
    return frame;
  }

  async function inflateRaw(compressed, expectedLength) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser cannot read a compressed fingerprint.");
    }
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      // Stop expansion at the declared length, before allocating an unbounded result.
      const reader = stream.getReader();
      const bytes = new Uint8Array(expectedLength);
      let cursor = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cursor + value.length > expectedLength) throw frameError("Fingerprint exceeds its declared length.");
          bytes.set(value, cursor);
          cursor += value.length;
        }
        if (cursor !== expectedLength) throw frameError("Truncated fingerprint.");
        return bytes;
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (error && error.code === "frame") throw error;
      throw frameError("Truncated fingerprint.");
    }
  }

  async function unpackFrame(packed) {
    if (packed.length < HEADER) throw frameError("Incomplete fingerprint frame.");
    const frame = packed.slice();
    scramble(frame, SEED);
    const bundle = frame[4] === 3 && (frame[5] === 3 || frame[5] === 4);
    const passwordProtected = (frame[4] === 2 && frame[5] === 2) || (bundle && frame[5] === 4);
    const magic = frame[0] === 0x50 && frame[1] === 0x43 && frame[2] === 0x46 && frame[3] === 0x31;
    if (!magic || !((frame[4] === 1 && frame[5] === 1) || (frame[4] === 2 && frame[5] === 2) || bundle) ||
      frame[6] > 1 || (passwordProtected && frame[6] !== 0) || frame[7] < 1 || frame[7] > 32) {
      throw frameError("Unsupported fingerprint frame.");
    }
    const rawLength = readU32(frame, 8);
    const bodyLength = readU32(frame, 12);
    const limit = bundle ? MAX_BUNDLE : MAX_TEXT;
    const max = passwordProtected ? ENVELOPE + limit : limit;
    if (rawLength < 1 || rawLength > max || bodyLength < 1 || bodyLength !== frame.length - HEADER) {
      throw frameError("Invalid fingerprint lengths.");
    }
    const payload = frame[6] === 0
      ? frame.slice(HEADER)
      : await inflateRaw(frame.subarray(HEADER), rawLength);
    if (payload.length !== rawLength || frameChecksum(frame, payload) !== readU32(frame, 16)) {
      throw frameError("Fingerprint checksum failed.");
    }
    if (passwordProtected) validateEnvelope(payload, bundle);
    else if (bundle) unpackBundle(payload);
    return { payload, strength: frame[7], passwordProtected, bundle, formatVersion: frame[4] };
  }

  function validateEnvelope(envelope, bundle = false) {
    const limit = bundle ? MAX_BUNDLE : MAX_TEXT;
    const psp1 = envelope.length > ENVELOPE &&
      envelope[0] === 0x50 && envelope[1] === 0x53 && envelope[2] === 0x50 && envelope[3] === 0x31 &&
      envelope[4] === (bundle ? 2 : 1) && envelope[5] === 1 && envelope[6] === 1 && envelope[7] <= 1 &&
      readU32(envelope, 8) === ITERATIONS;
    const textLength = psp1 ? readU32(envelope, 12) : 0;
    const stored = envelope.length - ENVELOPE;
    if (!psp1 || envelope.length > ENVELOPE + limit || textLength < 1 || textLength > limit ||
      (envelope[7] === 0 ? stored !== textLength : stored >= textLength)) {
      throw frameError("Unsupported password-protected payload.");
    }
  }

  async function deriveKey(password, salt) {
    const passwordBytes = strictUtf8(password);
    const base = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
    passwordBytes.fill(0);
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: ITERATIONS
    }, base, 256);
    return new Uint8Array(bits);
  }

  async function encryptEnvelope(textBytes, password, bundle = false) {
    let body = textBytes;
    let storedCompressed = 0;
    const deflated = await deflateRaw(textBytes);
    if (deflated.length > 0 && deflated.length < textBytes.length) {
      body = deflated;
      storedCompressed = 1;
    }
    const envelope = new Uint8Array(ENVELOPE + body.length);
    envelope.set([0x50, 0x53, 0x50, 0x31], 0);
    envelope[4] = bundle ? 2 : 1;
    envelope[5] = 1;
    envelope[6] = 1;
    envelope[7] = storedCompressed;
    writeU32(envelope, 8, ITERATIONS);
    writeU32(envelope, 12, textBytes.length);
    crypto.getRandomValues(envelope.subarray(16, 32));
    crypto.getRandomValues(envelope.subarray(32, 44));
    const key = await deriveKey(password, envelope.subarray(16, 32));
    try {
      const aes = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: envelope.subarray(32, 44),
        additionalData: envelope.subarray(0, 44),
        tagLength: 128
      }, aes, body));
      envelope.set(sealed.subarray(0, sealed.length - 16), ENVELOPE);
      envelope.set(sealed.subarray(sealed.length - 16), 44);
      return envelope;
    } finally {
      key.fill(0);
    }
  }

  async function decryptEnvelope(envelope, password, bundle = false) {
    validateEnvelope(envelope, bundle);
    const key = await deriveKey(password, envelope.subarray(16, 32));
    try {
      const aes = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
      const sealed = new Uint8Array(envelope.length - 44);
      sealed.set(envelope.subarray(ENVELOPE), 0);
      sealed.set(envelope.subarray(44, ENVELOPE), envelope.length - ENVELOPE);
      let plain;
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM",
          iv: envelope.subarray(32, 44),
          additionalData: envelope.subarray(0, 44),
          tagLength: 128
        }, aes, sealed));
      } catch (error) {
        if (error && error.name === "OperationError") {
          const denied = new Error("The password is incorrect, or the locked message is damaged.");
          denied.code = "incorrect";
          throw denied;
        }
        throw error;
      }
      if (envelope[7] === 0) return plain;
      try { return await inflateRaw(plain, readU32(envelope, 12)); }
      finally { plain.fill(0); }
    } finally {
      key.fill(0);
    }
  }

  function scaleWeight(amplitude, weight) {
    const product = amplitude * weight;
    if (product >= 0) return Math.trunc((product + 8) / 16);
    return -Math.trunc((-product + 8) / 16);
  }

  function shapeWeight(dx, dy, bit) {
    const distance = bit === 1 ? dx - dy : dx + dy - 3;
    return WAVELET[distance + 3];
  }

  function step(channel, delta) {
    if (channel + delta >= 0 && channel + delta <= 255) return delta;
    if (channel - delta >= 0 && channel - delta <= 255) return -delta;
    return 0;
  }

  function clampByte(value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return value;
  }

  function tryFitShift(reference, width, originX, originY, bit, amplitude, channel) {
    let minShift = -2147483648;
    let maxShift = 2147483647;
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const delta = scaleWeight(amplitude, shapeWeight(dx, dy, bit));
        const sample = reference[(originX + dx + (originY + dy) * width) * 4 + channel];
        const floor = -sample - delta;
        const ceil = 255 - sample - delta;
        if (floor > minShift) minShift = floor;
        if (ceil < maxShift) maxShift = ceil;
      }
    }
    if (minShift > maxShift) return { ok: false, shift: 0 };
    if (minShift > 0) return { ok: true, shift: minShift };
    if (maxShift < 0) return { ok: true, shift: maxShift };
    return { ok: true, shift: 0 };
  }

  function fitBias(reference, width, originX, originY, bit, amplitude) {
    const fit = [false, false, false];
    const shift = [0, 0, 0];
    for (let channel = 0; channel < 3; channel++) {
      const fitted = tryFitShift(reference, width, originX, originY, bit, amplitude, channel);
      fit[channel] = fitted.ok;
      shift[channel] = fitted.shift;
    }
    return { fit, shift };
  }

  function appliedDelta(reference, index, dx, dy, bit, amplitude, channel, bias) {
    const ideal = scaleWeight(amplitude, shapeWeight(dx, dy, bit));
    if (bias.fit[channel]) return ideal + bias.shift[channel];
    return step(reference[index + channel], ideal);
  }

  function expectedLuma(reference, index, dx, dy, bit, amplitude, bias) {
    return appliedDelta(reference, index, dx, dy, bit, amplitude, 0, bias) +
      appliedDelta(reference, index, dx, dy, bit, amplitude, 1, bias) +
      appliedDelta(reference, index, dx, dy, bit, amplitude, 2, bias);
  }

  function simulatedScore(reference, width, originX, originY, writtenBit, amplitude) {
    const biasOne = fitBias(reference, width, originX, originY, 1, amplitude);
    const biasZero = fitBias(reference, width, originX, originY, 0, amplitude);
    let favorOne = 0;
    let favorZero = 0;
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const index = (originX + dx + (originY + dy) * width) * 4;
        const one = expectedLuma(reference, index, dx, dy, 1, amplitude, biasOne);
        const zero = expectedLuma(reference, index, dx, dy, 0, amplitude, biasZero);
        const observed = writtenBit === 1 ? one : zero;
        favorOne += observed * one;
        favorZero += observed * zero;
      }
    }
    return favorOne - favorZero;
  }

  function resolveAmplitude(reference, width, originX, originY, strength) {
    for (let candidate = strength; candidate >= 1; candidate--) {
      if (simulatedScore(reference, width, originX, originY, 1, candidate) > 0 &&
        simulatedScore(reference, width, originX, originY, 0, candidate) < 0) {
        return candidate;
      }
    }
    return 0;
  }

  function v4SignalPolicy(ratio, strength, version = preferredCarrier) {
    // Use the actual fractional repetition budget, not its rounded copy count.
    // Five copies is the restrained case; near one copy spends more contrast.
    const pressure = Math.max(0, Math.min(1, (5 - ratio) / 4));
    const shortfall = Math.max(0, Math.min(1, 2 - ratio));
    // V6 grows gently below 2x, with a flatter shoulder around 1.5x.
    // Keep the same urgency at 2x and 1x; legacy encoders keep their curve.
    const urgency = version === CARRIER_V6 ? shortfall * shortfall : shortfall * (2 - shortfall);
    // A reciprocal uplift raises the existing curve by 15% at 2x, tapering
    // smoothly with more copies. The positive denominator and existing ceilings
    // keep low-redundancy pictures bounded. Quantise only after applying it.
    const uplift = redundancyUplift(ratio);
    const nominal = Math.min(32, (8 + 12 * pressure + 12 * urgency) * uplift);
    return { strength: Math.max(strength, Math.round(nominal * STRENGTH_CURVE_SCALE)),
      textureGain: (0.175 + 0.825 * pressure) * (1 + urgency) * uplift,
      payloadPeak: Math.min(V4_PAYLOAD_PEAK, Math.round((48 + 16 * urgency) * uplift)),
      markerPeak: Math.min(V4_MARKER_PEAK, Math.round((24 + 8 * urgency) * uplift)),
      biasLimit: Math.round(4 + 8 * urgency) };
  }

  function redundancyUplift(ratio) {
    return 1 + REDUNDANCY_UPLIFT_AT_TWO * (2 + REDUNDANCY_UPLIFT_DENOMINATOR) /
      (Math.max(1, ratio) + REDUNDANCY_UPLIFT_DENOMINATOR);
  }

  function encodingQuality(value = DEFAULT_QUALITY) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_QUALITY;
  }

  function qualitySignalPolicy(policy, quality) {
    // Left spends more contrast on recovery. 0.8 preserves the accepted curve;
    // 1.0 is about 13% gentler and 0.0 about 74% stronger, before hard ceilings.
    const gain = Math.pow(2, DEFAULT_QUALITY - quality);
    return { ...policy,
      strength: Math.max(8, Math.min(32, Math.round(policy.strength * gain))),
      textureGain: policy.textureGain * gain,
      payloadPeak: Math.min(V4_PAYLOAD_PEAK, Math.round(policy.payloadPeak * gain)),
      markerPeak: Math.min(V4_MARKER_PEAK, Math.round(policy.markerPeak * gain)),
      biasLimit: Math.min(16, Math.round(policy.biasLimit * gain)),
      markerMinimum: Math.max(8, Math.round(12 * gain)),
      markerTextureMinimum: 0.5 * gain };
  }

  function estimateSignalGain(ratio, quality = DEFAULT_QUALITY, version = preferredCarrier) {
    if (![CARRIER_V4, CARRIER_V5, CARRIER_V6].includes(version) || !Number.isFinite(ratio) || ratio < 1) return 1;
    const baseline = v4SignalPolicy(ratio, STRENGTHS[0], version);
    const selected = qualitySignalPolicy(baseline, encodingQuality(quality));
    // A relative strength hint for the UI, including hard ceilings. It is not
    // a measured optical success probability or a replacement for redundancy.
    return 0.5 * selected.strength / baseline.strength +
      0.35 * selected.textureGain / baseline.textureGain + 0.15 * selected.markerPeak / baseline.markerPeak;
  }

  function sourceRangeHeadroom(strength, signalPolicy, scalePilot = false) {
    return Math.min(62, 2 * Math.ceil((Math.max(12, strength) * 19 / 16 + signalPolicy.biasLimit +
      (scalePilot ? SCALE_PILOT.amplitude : 0)) / 2));
  }

  function brightnessCurveBaseline(headroom) {
    const bumpScale = 1 / (.375 ** 3 * .625 ** 5);
    const steepest = (21 - Math.sqrt(105)) / 56;
    const maxBumpSlope = bumpScale * steepest ** 2 * (1 - steepest) ** 4 * (3 - 8 * steepest);
    const boost = Math.min(.3 * headroom, .75 * 127.5 / maxBumpSlope);
    // The historical 0.3 multiplies headroom; it is NOT the slider value.
    // At x=1/4 the half-range coordinate is 1/2. Normalise its actual
    // displacement by 0.15, the span from 0.25 to the requested 0.10 limit.
    const amount = boost * bumpScale * .5 ** 3 * .5 ** 5 / (255 * .15);
    return { bumpScale, boost, amount };
  }

  function getBrightnessCurveDefault() {
    return DEFAULT_BRIGHTNESS_CURVE;
  }

  function normalizeBrightnessCurve(value = DEFAULT_BRIGHTNESS_CURVE) {
    const amount = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_BRIGHTNESS_CURVE;
    return Math.round(amount * V6_BRIGHTNESS_LEVELS) / V6_BRIGHTNESS_LEVELS;
  }

  const rangeTables = new Map();
  function rangeTable(headroom, curve, inverse, brightnessCurve) {
    if (!["linear", "sinusoidal", "magnifier-3-16", "luminance-v2"].includes(curve))
      throw frameError("Unsupported source brightness curve.");
    // A symmetric RGB map, including margins and marker reservations. Alpha is
    // unchanged. Adjustable V6 adds an outward contrast lift at 3/16 and 13/16,
    // then reserves headroom with its squared shoulder. Gentle keeps the sine.
    const baseline = brightnessCurveBaseline(headroom);
    // Both directions use the exact quantised value protected by the preamble.
    const amount = normalizeBrightnessCurve(brightnessCurve);
    const key = `${headroom}:${curve}:${inverse}:${amount}`;
    let table = rangeTables.get(key);
    if (!table) {
      const luminanceCurve = curve === "luminance-v2";
      table = luminanceCurve ? new Float64Array(256) : new Uint8Array(256);
      const scale = (255 - 2 * headroom) / 255;
      const magnifier = curve === "magnifier-3-16" || luminanceCurve;
      const sineShoulder = (unit, power) => (1 - Math.sin(Math.PI * unit)) ** power;
      // Power 2 is the squared shoulder. A pure square folds the darkest codes
      // once headroom exceeds 255/pi, so ease the power only that far.
      const shoulderPower = magnifier ? Math.min(2, 255 / (headroom * Math.PI)) : 1;
      // On each half, s^3(1-s)^5 has its peak at s=3/8: brightness 3/16
      // and, by symmetry, 13/16. Its endpoint tangents are zero. Warp the source
      // coordinate before the headroom map, so lifting contrast never consumes
      // reserved black/white headroom or modifies a completed wavelet.
      const { bumpScale, boost } = baseline;
      const currentForward = (value) => {
        if (magnifier) {
          const unit = value / 127.5;
          // At high headroom cap the lift so this coordinate warp still has
          // at least 1/4 slope, rather than folding or flattening source tones.
          value -= boost * bumpScale * unit ** 3 * (1 - unit) ** 5;
        }
        return value + headroom * sineShoulder(value / 255, shoulderPower);
      };
      const forward = (value) => {
        if (value > 127.5) return 255 - forward(255 - value);
        if (!magnifier || amount === baseline.amount) return currentForward(value);
        const unit = value / 255;
        const half = value / 127.5;
        const currentWarp = value - boost * bumpScale * half ** 3 * (1 - half) ** 5;
        let warped, shoulderBlend;
        if (amount < baseline.amount) {
          shoulderBlend = amount / baseline.amount;
          warped = value + shoulderBlend * (currentWarp - value);
        } else {
          // x^2/(x^2+(1-x)^2) smoothly maps 1/4 to 0.10 and 3/4 to
          // 0.90. Blending source coordinates, rather than finished outputs,
          // gives 1/4 -> 0.25-0.15*amount at EVERY slider value.
          const extremeWarp = 255 * unit ** 2 / (unit ** 2 + (1 - unit) ** 2);
          warped = currentWarp + (amount - baseline.amount) / (1 - baseline.amount) * (extremeWarp - currentWarp);
          shoulderBlend = 1;
        }
        // Keep signal headroom separate from the normalised tone coordinates.
        // At zero even the shoulder is linear; at the calculated default it
        // is exactly the existing shoulder. Both maps reserve the full margin.
        const linear = headroom + warped * scale;
        const shoulder = warped + headroom * sineShoulder(warped / 255, shoulderPower);
        return linear + shoulderBlend * (shoulder - linear);
      };
      const curved = curve === "sinusoidal" || magnifier;
      const samples = curved ? luminanceCurve ? new Float64Array(256) : new Uint8Array(256) : null;
      if (samples) {
        let previous = 0;
        for (let value = 0; value < 256; value++) {
          // Luminance is not a stored channel: quantise only the final RGB.
          // Rounding it here creates plateaus which erase chroma information
          // when the inverse tries to locate a saturated colour's brightness.
          const y = luminanceCurve ? forward(value) : clampChannel(forward(value));
          // Squaring steepens the ends at high headroom. Hold the integer map
          // so a later code is never darker than the one before it.
          samples[value] = magnifier ? Math.max(previous, y) : y;
          previous = samples[value];
        }
        if (magnifier)
          for (let value = 128; value < 256; value++) samples[value] = 255 - samples[255 - value];
      }
      for (let value = 0; value < 256; value++) {
        if (!curved) {
          // Preserve the exact inverse used by existing linear-range images.
          table[value] = clampChannel(inverse ? (value - headroom) / scale : headroom + value * scale);
        } else if (!inverse) table[value] = samples[value];
        else if (luminanceCurve) table[value] = inverseRangeSample(samples, value);
        else if (magnifier) {
          // Undo uses the same integer shoulder that encoding wrote. Where
          // several source codes share an output, return the centre of that
          // run so the recovered code stays at the encoded point.
          let best = 255;
          for (let source = 0; source < 256; source++) best = Math.min(best, Math.abs(samples[source] - value));
          let low = 0;
          while (Math.abs(samples[low] - value) > best) low++;
          let high = low;
          while (high + 1 < 256 && Math.abs(samples[high + 1] - value) === best) high++;
          table[value] = (low + high) >> 1;
        } else {
          // Invert the continuous sine before quantizing. Out-of-range residue
          // from wavelet removal naturally clamps to black or white.
          let low = 0, high = 255;
          for (let step = 0; step < 24; step++) {
            const middle = (low + high) / 2;
            if (forward(middle) < value) low = middle; else high = middle;
          }
          table[value] = clampChannel((low + high) / 2);
        }
      }
      if (inverse && magnifier) {
        // Mirror tie-breaking too: flooring both halves independently biases
        // both towards black and can skew colours near quantised shoulders.
        for (let value = 128; value < 256; value++) table[value] = 255 - table[255 - value];
      }
      rangeTables.set(key, table);
    }
    return table;
  }

  function mapRange(pixels, headroom, curve = "linear", inverse = false, brightnessCurve) {
    const table = rangeTable(headroom, curve, inverse, brightnessCurve);
    const output = pixels.slice();
    for (let i = 0; i < output.length; i += 4) for (let channel = 0; channel < 3; channel++)
      output[i + channel] = table[pixels[i + channel]];
    return output;
  }

  const rangeSrgbToLinear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  const rangeLinearToSrgb = value => value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055;
  const rangeLinearChannels = Float64Array.from({ length: 256 }, (_, value) => rangeSrgbToLinear(value / 255));

  function inverseRangeSample(table, value) {
    if (value <= table[0]) return 0;
    if (value >= table[255]) return 255;
    let low = 0, high = 255;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (table[middle] < value) low = middle; else high = middle;
    }
    return low + (value - table[low]) / (table[high] - table[low]);
  }

  function luminanceChromaGain(sourceY, mappedY, darkest, brightest, black, white, inverse = false) {
    const nominal = sourceY > 0 ? mappedY / sourceY : 0;
    if (!(nominal > 0)) return 0;
    let sourceLimit = Infinity, mappedLimit = Infinity;
    if (darkest < 0) {
      sourceLimit = Math.min(sourceLimit, sourceY / -darkest);
      mappedLimit = Math.min(mappedLimit, (mappedY - black) / -darkest);
    }
    if (brightest > 0) {
      sourceLimit = Math.min(sourceLimit, (1 - sourceY) / brightest);
      mappedLimit = Math.min(mappedLimit, (white - mappedY) / brightest);
    }
    if (!Number.isFinite(sourceLimit)) return inverse ? 1 / nominal : nominal;
    if (!(sourceLimit > 0 && mappedLimit > 0)) return 0;
    const expansion = nominal * sourceLimit / mappedLimit;
    if (expansion <= 1) return inverse ? 1 / nominal : nominal;
    // Map the fraction of available chroma s with k*s/(1+(k-1)*s).
    // Unlike hard gamut clipping, this is smooth, strictly increasing and
    // invertible all the way to saturated colours. Luminance and hue stay fixed.
    if (!inverse) return nominal / (1 + (expansion - 1) / sourceLimit);
    const fraction = Math.min(1, 1 / mappedLimit);
    return sourceLimit * fraction / (expansion - (expansion - 1) * fraction);
  }

  async function mapLuminanceRange(pixels, headroom, curve, brightnessCurve) {
    // Apply the stored scalar curve once to luminance instead of independently
    // warping R, G and B. Compress chroma reversibly into the signal margins.
    const table = rangeTable(headroom, curve, false, brightnessCurve);
    const black = rangeLinearChannels[headroom], white = rangeLinearChannels[255 - headroom];
    const output = pixels.slice();
    for (let i = 0; i < pixels.length; i += 4) {
      if (i && (i & 0x3FFFF) === 0) await yieldNow();
      const r = rangeLinearChannels[pixels[i]], g = rangeLinearChannels[pixels[i + 1]], b = rangeLinearChannels[pixels[i + 2]];
      const luminance = toneLuma(r, g, b);
      // Express luminance as an sRGB grey level so the existing 0..1 slider
      // coordinates and greyscale curve do not change their meaning.
      const grey = clampRange(255 * rangeLinearToSrgb(luminance), 0, 255);
      const low = Math.floor(grey), fraction = grey - low;
      const mapped = table[low] * (1 - fraction) + table[Math.min(255, low + 1)] * fraction;
      const target = clampRange(rangeSrgbToLinear(mapped / 255), black, white);
      const darkest = Math.min(r, g, b) - luminance, brightest = Math.max(r, g, b) - luminance;
      const gain = luminanceChromaGain(luminance, target, darkest, brightest, black, white);
      output[i] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (r - luminance), black, white)));
      output[i + 1] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (g - luminance), black, white)));
      output[i + 2] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (b - luminance), black, white)));
    }
    return output;
  }

  async function restorePhotoRange(pixels, width, height, headroom, curve, signal, brightnessCurve) {
    const table = rangeTable(headroom, curve, true, brightnessCurve), output = pixels.slice();
    const lookup = value => {
      const low = Math.floor(value), fraction = value - low;
      return table[low] * (1 - fraction) + table[Math.min(255, low + 1)] * fraction;
    };
    // Near the range shoulders a one-code camera residual can become many
    // source codes. Invert the local base, but limit that amplification in
    // fine detail. RGB-guided weights keep the base on the same side of edges.
    // This is only for resampled/photographed carriers; native files use the
    // exact integer inverse without spatial filtering.
    for (let y = 0; y < height; y++) {
      if ((y & 31) === 31) { await yieldNow(); checkCancelled(signal); }
      for (let x = 0; x < width; x++) {
        const i = (x + y * width) * 4;
        if (!pixels[i + 3]) continue;
        let total = 0, r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          if (y + dy < 0 || y + dy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= width) continue;
            const j = (x + dx + (y + dy) * width) * 4;
            const dr = pixels[j] - pixels[i], dg = pixels[j + 1] - pixels[i + 1], db = pixels[j + 2] - pixels[i + 2];
            const distance = (dr * dr + dg * dg + db * db) / (3 * 16 * 16);
            const weight = (dx ? 1 : 2) * (dy ? 1 : 2) * pixels[j + 3] / 255 / (1 + distance * distance);
            total += weight; r += weight * pixels[j]; g += weight * pixels[j + 1]; b += weight * pixels[j + 2];
          }
        }
        for (let c = 0; c < 3; c++) {
          const value = pixels[i + c], mean = clampRange((c === 0 ? r : c === 1 ? g : b) / total, 0, 255), base = lookup(mean);
          const limit = 2 * Math.abs(value - mean);
          output[i + c] = clampChannel(base + clampRange(table[value] - base, -limit, limit));
        }
      }
    }
    checkCancelled(signal);
    return output;
  }

  async function restoreLuminanceRange(pixels, width, height, headroom, curve, brightnessCurve, photographed, signal) {
    const table = rangeTable(headroom, curve, false, brightnessCurve), output = pixels.slice();
    const black = rangeLinearChannels[headroom], white = rangeLinearChannels[255 - headroom];
    const lookup = value => inverseRangeSample(table, value);
    for (let y = 0; y < height; y++) {
      if ((y & 31) === 31) { await yieldNow(); checkCancelled(signal); }
      for (let x = 0; x < width; x++) {
        const i = (x + y * width) * 4;
        if (!pixels[i + 3]) continue;
        const r = rangeLinearChannels[pixels[i]], g = rangeLinearChannels[pixels[i + 1]], b = rangeLinearChannels[pixels[i + 2]];
        const luminance = toneLuma(r, g, b);
        const grey = clampRange(255 * rangeLinearToSrgb(luminance), 0, 255);
        let restored = lookup(grey);
        if (photographed) {
          // Preserve the existing photo safeguard: invert an RGB-guided local
          // brightness base, limiting amplification of camera detail to 2x.
          // The inverse is applied only to luminance, never three RGB curves.
          let total = 0, red = 0, green = 0, blue = 0;
          for (let dy = -1; dy <= 1; dy++) {
            if (y + dy < 0 || y + dy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (x + dx < 0 || x + dx >= width) continue;
              const j = (x + dx + (y + dy) * width) * 4;
              const dr = pixels[j] - pixels[i], dg = pixels[j + 1] - pixels[i + 1], db = pixels[j + 2] - pixels[i + 2];
              const distance = (dr * dr + dg * dg + db * db) / (3 * 16 * 16);
              const weight = (dx ? 1 : 2) * (dy ? 1 : 2) * pixels[j + 3] / 255 / (1 + distance * distance);
              total += weight; red += weight * pixels[j]; green += weight * pixels[j + 1]; blue += weight * pixels[j + 2];
            }
          }
          const mean = 255 * rangeLinearToSrgb(toneLuma(rangeSrgbToLinear(red / total / 255),
            rangeSrgbToLinear(green / total / 255), rangeSrgbToLinear(blue / total / 255)));
          const base = lookup(mean), limit = 2 * Math.abs(grey - mean);
          restored = base + clampRange(restored - base, -limit, limit);
        }
        const target = rangeSrgbToLinear(clampRange(restored, 0, 255) / 255);
        const darkest = Math.min(r, g, b) - luminance, brightest = Math.max(r, g, b) - luminance;
        // Undo the encoder's chroma compression as well as its brightness map.
        // Bound camera/quantisation residuals to the original RGB gamut.
        let gain = luminanceChromaGain(target, luminance, darkest, brightest, black, white, true);
        if (darkest < 0) gain = Math.min(gain, target / -darkest);
        if (brightest > 0) gain = Math.min(gain, (1 - target) / brightest);
        gain = Math.max(0, gain);
        output[i] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (r - luminance), 0, 1)));
        output[i + 1] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (g - luminance), 0, 1)));
        output[i + 2] = clampChannel(255 * rangeLinearToSrgb(clampRange(target + gain * (b - luminance), 0, 1)));
      }
    }
    checkCancelled(signal);
    return output;
  }

  function applyScalePilot(pixels, width, inverse = false, amplitude = SCALE_PILOT.amplitude) {
    // Paint under the four-pixel payload wavelets, on the headroom-compressed
    // reference. Integer deltas are reversible after carrier removal; alpha and
    // the original pixels remain untouched. Native periods: 128, 85 1/3, 51.2.
    const output = pixels.slice(), deltas = new Int8Array(width);
    for (let x = 0; x < width; x++) deltas[x] = Math.round(amplitude / 2.4 *
      SCALE_PILOT.tones.reduce((sum, tone) => sum + tone.weight * Math.cos(2 * Math.PI * tone.k * x / SCALE_PILOT.period + tone.phase), 0));
    for (let i = 0; i < pixels.length; i += 4) {
      const delta = deltas[(i / 4) % width] * (inverse ? -1 : 1);
      for (let c = 0; c < 3; c++) output[i + c] = clampByte(pixels[i + c] + delta);
    }
    return output;
  }

  function linearAmplitude(reference, width, x, y, requested, localFit = false) {
    const fits = (amplitude) => [0, 1].every((bit) => {
      const bias = fitBias(reference, width, x, y, bit, amplitude);
      return bias.fit.every(Boolean) && (localFit || bias.shift.every((shift) => shift === 0));
    });
    if (fits(requested)) return requested;
    let low = 0, high = requested;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (fits(middle)) low = middle; else high = middle;
    }
    return low;
  }

  function linearMarkerGain(reference, width, x, y, grid, requested) {
    let gain = requested;
    for (const kernel of grid.kernels) for (let i = 0; i < kernel.length; i++) {
      if (kernel[i] === 0) continue;
      const index = (x + i % grid.cell + (y + Math.floor(i / grid.cell)) * width) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const sample = reference[index + channel];
        gain = Math.min(gain, kernel[i] > 0 ? (255 - sample) / kernel[i] : sample / -kernel[i]);
      }
    }
    return Math.max(0, gain);
  }

  function textureAmplitude(reference, width, x, y, side, policy, ceiling) {
    // Measure source detail after removing a plane. A smooth slope or a bright
    // flat sky is not noise. No encoded pixels or payload bits enter this test.
    let sum = 0, squares = 0, slopeX = 0, slopeY = 0;
    const middle = (side - 1) / 2, count = side * side;
    for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) {
      const index = (x + dx + (y + dy) * width) * 4;
      const value = (reference[index] + reference[index + 1] + reference[index + 2]) / 3;
      sum += value; squares += value * value;
      slopeX += value * (dx - middle); slopeY += value * (dy - middle);
    }
    const axisEnergy = count * (side * side - 1) / 12;
    const residual = Math.max(0, squares - sum * sum / count - (slopeX * slopeX + slopeY * slopeY) / axisEnergy);
    const rms = Math.sqrt(residual / count);
    return Math.min(ceiling, policy.strength + Math.round(rms * policy.textureGain));
  }

  function limitBoostHeadroom(reference, width, x, y, requested, nominal, biasLimit = 4) {
    if (requested <= nominal) return requested;
    const raised = [0, 1].map((bit) => fitBias(reference, width, x, y, bit, requested));
    // Ordinary unclipped blocks need no further work. Increasing amplitude
    // cannot reduce an already-required shift to zero, so their nominal fit
    // will also be neutral.
    if (raised.every((bias) => bias.fit.every(Boolean) && bias.shift.every((value) => value === 0))) return requested;
    const baseline = [0, 1].map((bit) => fitBias(reference, width, x, y, bit, nominal));
    // A per-channel sign flip is the legacy last resort on extreme colours.
    // Never increase its amplitude as a texture boost.
    if (baseline.some((bias) => bias.fit.some((value) => !value))) return nominal;
    const acceptable = (biases) => biases.every((bias, bit) => {
      if (bias.fit.some((value) => !value)) return false;
      const added = bias.shift.map((value, channel) => value - baseline[bit].shift[channel]);
      return added.every((value) => Math.abs(value) <= biasLimit) && Math.max(...added) - Math.min(...added) <= 2;
    });
    if (acceptable(raised)) return requested;
    // Select a conservative valid amplitude without a long decrement sweep.
    let low = nominal, high = requested;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (acceptable([0, 1].map((bit) => fitBias(reference, width, x, y, bit, middle)))) low = middle;
      else high = middle;
    }
    return low;
  }

  function blockAmplitude(reference, width, column, blockRow, strength, amplitudeCache, signalPolicy) {
    const originX = column * BLOCK;
    const originY = blockRow * BLOCK;
    const cacheIndex = amplitudeCache ? column + blockRow * (width / BLOCK | 0) : -1;
    let amplitude = cacheIndex >= 0 ? amplitudeCache[cacheIndex] : -1;
    if (amplitude < 0) {
      const texture = signalPolicy ? textureAmplitude(signalPolicy.textureSource || reference, width, originX, originY,
        BLOCK, signalPolicy, signalPolicy.payloadPeak) : strength;
      const requested = signalPolicy?.rangeHeadroom || signalPolicy?.localFit ? texture : signalPolicy
        ? limitBoostHeadroom(reference, width, originX, originY, texture, strength, signalPolicy.biasLimit) : strength;
      amplitude = signalPolicy?.rangeHeadroom || signalPolicy?.localFit ? linearAmplitude(reference, width, originX, originY, requested, signalPolicy?.localFit)
        : resolveAmplitude(reference, width, originX, originY, requested);
      if (cacheIndex >= 0) amplitudeCache[cacheIndex] = amplitude;
    }
    return amplitude;
  }

  function applyBit(reference, image, width, column, blockRow, bit, strength, amplitudeCache, signalPolicy) {
    const originX = column * BLOCK, originY = blockRow * BLOCK;
    const amplitude = blockAmplitude(reference, width, column, blockRow, strength, amplitudeCache, signalPolicy);
    if (amplitude === 0) return;
    const bias = fitBias(reference, width, originX, originY, bit, amplitude);
    const coloured = signalPolicy?.tintPayload && fitTintedWavelet(reference, signalPolicy.colourSource || signalPolicy.textureSource || reference,
      width, originX, originY, bit, amplitude, Boolean(signalPolicy.localFit));
    for (let dy = 0; dy < BLOCK; dy++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const index = (originX + dx + (originY + dy) * width) * 4;
        for (let c = 0; c < 3; c++) image[index + c] = coloured
          ? reference[index + c] + coloured.delta[(dx + dy * 4) * 3 + c] + bias.shift[c]
          : clampByte(reference[index + c] + appliedDelta(reference, index, dx, dy, bit, amplitude, c, bias));
        image[index + 3] = reference[index + 3];
      }
    }
  }

  function tintFromMeans(r, g, b) {
    const mean = (r + g + b) / 3, denominator = Math.max(mean + 32, Math.abs(r - mean), Math.abs(g - mean), Math.abs(b - mean));
    return [COLOUR_WAVELET_TINT * (r - mean) / denominator, COLOUR_WAVELET_TINT * (b - mean) / denominator];
  }

  // The original is the appearance target; the frozen prepared carrier is
  // the fitting constraint. Neither palette path samples completed wavelets.
  function signalTint(colourTarget, width, x, y, side) {
    const count = side ** 2; let r = 0, g = 0, b = 0;
    for (let k = 0; k < count; k++) {
      const i = (x + k % side + (y + Math.floor(k / side)) * width) * 4;
      r += colourTarget[i] / count; g += colourTarget[i + 1] / count; b += colourTarget[i + 2] / count;
    }
    return tintFromMeans(r, g, b);
  }

  // Shared payload/marker chroma deltas, generated before fitting to the source.
  // Each channel's cell sum and each pixel's RGB sum are exactly zero.
  function signalValue(kernel, k, amplitude, bit, gain) {
    return kernel ? gain * kernel[k] : scaleWeight(amplitude, shapeWeight(k % 4, Math.floor(k / 4), bit));
  }

  function colourOffsets(kernel, redTint, blueTint, amplitude = 0, bit = 0, gain = 1) {
    const count = kernel ? kernel.length : 16, delta = new Int16Array(count * 3);
    let mean = 0; for (let k = 0; k < count; k++) mean += signalValue(kernel, k, amplitude, bit, gain) / count;
    let redSum = 0, blueSum = 0, redWritten = 0, blueWritten = 0;
    for (let k = 0; k < count; k++) {
      const signal = signalValue(kernel, k, amplitude, bit, gain) - mean;
      redSum += signal * redTint; blueSum += signal * blueTint;
      const redNext = k === count - 1 ? 0 : roundHalfToEven(redSum), blueNext = k === count - 1 ? 0 : roundHalfToEven(blueSum);
      const red = redNext - redWritten, blue = blueNext - blueWritten;
      delta[k * 3] = red; delta[k * 3 + 1] = -red - blue; delta[k * 3 + 2] = blue;
      redWritten = redNext; blueWritten = blueNext;
    }
    return delta;
  }

  function tintedWavelet(amplitude, bit, redTint, blueTint) {
    const delta = colourOffsets(null, redTint, blueTint, amplitude, bit);
    for (let k = 0; k < 16; k++) {
      const signal = scaleWeight(amplitude, shapeWeight(k % 4, Math.floor(k / 4), bit));
      for (let c = 0; c < 3; c++) delta[k * 3 + c] += signal;
    }
    return delta;
  }

  function fitTintedWavelet(reference, colourTarget, width, x, y, bit, amplitude, localFit) {
    const [redTint, blueTint] = signalTint(colourTarget, width, x, y, 4);
    if (Math.max(Math.abs(redTint), Math.abs(blueTint)) < .001) return null;
    const zeroBias = localFit ? fitBias(reference, width, x, y, 0, amplitude) : { shift: [0, 0, 0] };
    const oneBias = localFit ? fitBias(reference, width, x, y, 1, amplitude) : { shift: [0, 0, 0] };
    const fits = (delta, bias) => {
      for (let k = 0; k < 16; k++) for (let c = 0; c < 3; c++) {
        const value = reference[(x + k % 4 + (y + Math.floor(k / 4)) * width) * 4 + c] + delta[k * 3 + c] + bias.shift[c];
        if (value < 0 || value > 255) return false;
      }
      return true;
    };
    for (let amount = 1; amount >= 1 / 32; amount /= 2) {
      const zero = tintedWavelet(amplitude, 0, redTint * amount, blueTint * amount);
      const one = tintedWavelet(amplitude, 1, redTint * amount, blueTint * amount);
      if (fits(zero, zeroBias) && fits(one, oneBias))
        return { delta: bit ? one : zero, redTint: redTint * amount, blueTint: blueTint * amount };
    }
    return null;
  }

  function scatterOrder(blockCount, seed) {
    const order = new Uint32Array(blockCount);
    for (let i = 0; i < blockCount; i++) order[i] = i;
    let state = (seed ^ 0x51F15E5D) >>> 0;
    for (let i = blockCount - 1; i > 0; i--) {
      state = xorshift32(state);
      const pick = state % (i + 1);
      const swap = order[i];
      order[i] = order[pick];
      order[pick] = swap;
    }
    return order;
  }

  async function writeBits(reference, image, width, columns, slots, bitAt, strength, amplitudeCache, signalPolicy) {
    for (let slot = 0; slot < slots.length; slot++) {
      if ((slot & 8191) === 8191) await yieldNow();
      const bit = bitAt(slot);
      const block = slots[slot];
      applyBit(reference, image, width, block % columns, Math.floor(block / columns), bit, strength, amplitudeCache, signalPolicy);
    }
  }

  function riskLayout(map, width, height) {
    if (!map || map.length <= carrierOverhead(CARRIER_V6)) throw frameError("The image has no room for the protected repetition map.");
    return { map, width, height, columns: Math.floor(width / BLOCK), rows: Math.floor(height / BLOCK),
      order: scatterOrder(map.length - PREAMBLE_BLOCKS, RISK_SEED) };
  }

  function riskTile(layout, block) {
    const x = block % layout.columns, y = Math.floor(block / layout.columns);
    return Math.floor(x * RISK_GRID / layout.columns) + RISK_GRID * Math.floor(y * RISK_GRID / layout.rows);
  }

  async function measureRiskMap(reference, layout, strength, amplitudeCache, signalPolicy) {
    const sums = new Float64Array(RISK_TILES), counts = new Uint32Array(RISK_TILES);
    const difference = buildShapes(strength).difference, projections = new Map(), block = new Float64Array(16);
    for (let slot = RISK_MAP_BLOCKS; slot < layout.order.length; slot++) {
      if ((slot & 8191) === 0) await yieldNow();
      const index = PREAMBLE_BLOCKS + layout.order[slot], physical = layout.map[index];
      const column = physical % layout.columns, row = Math.floor(physical / layout.columns);
      const x = column * BLOCK, y = row * BLOCK;
      const amplitude = blockAmplitude(reference, layout.width, column, row, strength, amplitudeCache, signalPolicy);
      let signal = projections.get(amplitude);
      if (!signal) {
        let zero = 0, one = 0;
        for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) {
          const k = dx + dy * BLOCK;
          zero += scaleWeight(amplitude, shapeWeight(dx, dy, 0)) * difference[k];
          one += scaleWeight(amplitude, shapeWeight(dx, dy, 1)) * difference[k];
        }
        signal = { zero, one }; projections.set(amplitude, signal);
      }
      let projection = 0, opacity = 0;
      for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) {
        const k = dx + dy * BLOCK, pixel = (x + dx + (y + dy) * layout.width) * 4;
        block[k] = (reference[pixel] + reference[pixel + 1] + reference[pixel + 2]) / 3;
        projection += block[k] * difference[k]; opacity += reference[pixel + 3] / 255;
      }
      let noise = 25;
      for (const kernel of NOISE_KERNELS) {
        let coefficient = 0;
        for (let k = 0; k < 16; k++) coefficient += block[k] * kernel[k];
        noise += coefficient * coefficient;
      }
      // Assess the weaker bit polarity against the actual fitted amplitude and
      // source interference. The map does not depend on message or password bits.
      const margin = Math.max(0, Math.min(projection + signal.one, -projection - signal.zero));
      const confidence = Math.min(8, margin / Math.sqrt(noise)) * opacity / 16;
      const tile = riskTile(layout, physical);
      sums[tile] += 1 / (.25 + confidence); counts[tile]++;
    }
    const risks = new Uint8Array(RISK_TILES);
    for (let tile = 0; tile < risks.length; tile++) {
      // A harmonic mean keeps weak cells from disappearing into a bright,
      // otherwise easy tile. Four absolute levels avoid inventing risk on a
      // uniformly clean image just to fill arbitrary quantiles.
      const confidence = counts[tile] ? counts[tile] / sums[tile] - .25 : 8;
      risks[tile] = confidence < 2 ? 0 : confidence < 4 ? 1 : confidence < 6 ? 2 : 3;
    }
    return risks;
  }

  function riskMapChecksum(bytes, layout, framedBytes, bitsPerByte) {
    const context = new Uint8Array(RISK_MAP_BODY_BYTES + 13);
    context.set(bytes.subarray(0, RISK_MAP_BODY_BYTES));
    writeU32(context, RISK_MAP_BODY_BYTES, layout.width);
    writeU32(context, RISK_MAP_BODY_BYTES + 4, layout.height);
    writeU32(context, RISK_MAP_BODY_BYTES + 8, framedBytes);
    context[RISK_MAP_BODY_BYTES + 12] = bitsPerByte;
    return crc32(context, 0, context.length);
  }

  function packRiskMap(risks, layout, framedBytes, bitsPerByte) {
    const bytes = new Uint8Array(RISK_MAP_BYTES);
    bytes[0] = 0x52; bytes[1] = 0x36;
    for (let tile = 0; tile < risks.length; tile++) bytes[2 + (tile >> 2)] |= risks[tile] << (6 - 2 * (tile & 3));
    writeU32(bytes, RISK_MAP_BODY_BYTES, riskMapChecksum(bytes, layout, framedBytes, bitsPerByte));
    scramble(bytes, RISK_SEED);
    return bytes;
  }

  function readRiskMap(scores, layout, framedBytes, bitsPerByte, failure) {
    const combined = new Float64Array(RISK_MAP_BYTES * 12);
    for (let slot = 0; slot < RISK_MAP_BLOCKS; slot++)
      combined[slot % combined.length] += scores[PREAMBLE_BLOCKS + layout.order[slot]];
    const decoded = decodeSoft(combined, RISK_MAP_BYTES);
    scramble(decoded.bytes, RISK_SEED);
    const bytes = decoded.bytes;
    if (bytes[0] !== 0x52 || bytes[1] !== 0x36 ||
      readU32(bytes, RISK_MAP_BODY_BYTES) !== riskMapChecksum(bytes, layout, framedBytes, bitsPerByte)) {
      recordReadFailure(failure, { stage: "allocation", reason: "The protected repetition map failed its checksum.",
        corrections: decoded.corrections, framedBytes: RISK_MAP_BYTES, parityBits: 4 });
      throw frameError("The protected repetition map failed its checksum.");
    }
    const risks = new Uint8Array(RISK_TILES);
    for (let tile = 0; tile < risks.length; tile++) risks[tile] = (bytes[2 + (tile >> 2)] >> (6 - 2 * (tile & 3))) & 3;
    bytes.fill(0);
    return { risks, corrections: decoded.corrections };
  }

  async function walkRiskAllocation(risks, layout, codedBits, visit, signal) {
    const length = layout.order.length - RISK_MAP_BLOCKS;
    if (length < codedBits) throw frameError("The image does not hold a complete copy of the payload.");
    const sizes = new Uint32Array(4);
    for (let i = RISK_MAP_BLOCKS; i < layout.order.length; i++) {
      if ((i & 8191) === 0) { checkCancelled(signal); await yieldNow(); }
      const index = PREAMBLE_BLOCKS + layout.order[i];
      sizes[risks[riskTile(layout, layout.map[index])]]++;
    }
    const starts = new Uint32Array(4);
    for (let level = 1; level < 4; level++) starts[level] = starts[level - 1] + sizes[level - 1];
    const positions = new Uint32Array(length), tiles = new Uint8Array(length);
    for (let i = RISK_MAP_BLOCKS; i < layout.order.length; i++) {
      if ((i & 8191) === 0) { checkCancelled(signal); await yieldNow(); }
      const index = PREAMBLE_BLOCKS + layout.order[i], tile = riskTile(layout, layout.map[index]);
      const target = starts[risks[tile]]++;
      positions[target] = index; tiles[target] = tile;
    }
    // First place every coded bit once, starting with the least reliable cells.
    // Spare cells are safer; spend them on the weakest combined protection.
    const protection = new Uint32Array(codedBits), copies = new Uint32Array(codedBits);
    const firstTile = new Uint8Array(codedBits), lastTile = new Uint8Array(codedBits), heap = new Uint32Array(codedBits);
    let weakBits = 0, weakRepeatedBits = 0;
    for (let bit = 0; bit < codedBits; bit++) {
      if ((bit & 8191) === 0) { checkCancelled(signal); await yieldNow(); }
      const tile = tiles[bit], weight = RISK_WEIGHTS[risks[tile]];
      protection[bit] = weight; copies[bit] = 1; firstTile[bit] = lastTile[bit] = tile; heap[bit] = bit;
      if (weight <= 2) weakBits++;
      visit(bit, positions[bit], weight);
    }
    const less = (a, b) => protection[a] < protection[b] || protection[a] === protection[b] && a < b;
    let size = codedBits;
    const down = (index) => {
      for (;;) {
        let child = index * 2 + 1;
        if (child >= size) return;
        if (child + 1 < size && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], heap[index])) return;
        const value = heap[index]; heap[index] = heap[child]; heap[child] = value; index = child;
      }
    };
    for (let i = Math.floor(size / 2) - 1; i >= 0; i--) down(i);
    const take = () => {
      const value = heap[0], tail = heap[--size];
      if (size) { heap[0] = tail; down(0); }
      return value;
    };
    const put = (bit) => {
      let index = size++;
      while (index) {
        const parent = (index - 1) >> 1;
        if (!less(bit, heap[parent])) break;
        heap[index] = heap[parent]; index = parent;
      }
      heap[index] = bit;
    };
    const held = new Uint32Array(8);
    for (let slot = codedBits; slot < length; slot++) {
      if ((slot & 8191) === 0) { checkCancelled(signal); await yieldNow(); }
      const tile = tiles[slot], weight = RISK_WEIGHTS[risks[tile]], limit = Math.min(held.length, size);
      let count = 0, bit = -1;
      while (count < limit) {
        const candidate = take(); held[count++] = candidate;
        if (firstTile[candidate] !== tile && lastTile[candidate] !== tile) { bit = candidate; break; }
      }
      if (bit < 0) bit = held[0];
      for (let i = 0; i < count; i++) if (held[i] !== bit) put(held[i]);
      if (copies[bit] === 1 && protection[bit] <= 2) weakRepeatedBits++;
      protection[bit] += weight; copies[bit]++; lastTile[bit] = tile; put(bit);
      visit(bit, positions[slot], weight);
    }
    let minCopies = length, maxCopies = 0, repeatedBits = 0;
    for (const count of copies) { minCopies = Math.min(minCopies, count); maxCopies = Math.max(maxCopies, count); if (count > 1) repeatedBits++; }
    const levels = new Uint32Array(4);
    for (const level of risks) levels[level]++;
    return { mapBytes: RISK_MAP_BYTES, mapBlocks: RISK_MAP_BLOCKS, codedBits, minCopies, maxCopies, repeatedBits,
      weakBits, weakRepeatedBits, tileLevels: Array.from(levels) };
  }

  // Versioned geometry profiles. Payload/encryption envelopes are independent.
  // V3 is frozen. V4 keeps its eight patches and wavelets, balances brightness
  // and adapts contrast to source detail/redundancy. V6 versions the accepted
  // compact-marker writer separately; legacy profiles require explicit selection.
  const LOCATOR_INSET = 8;
  const LOCATOR_STRENGTH = 16;
  const LOCATOR_PROFILES = new Map([
    [3, { version: 3, cell: 6, columns: 12, rows: 8, width: 72, height: 48,
      magic: 0xD3, tag: 0x30, seed: 0x50534C33, ids: [0, 2, 6, 8, 1, 3, 5, 7], sampleStep: 1.5, sampleOffset: 0.5 }],
    [4, { version: 4, cell: 6, columns: 12, rows: 8, width: 72, height: 48,
      magic: 0xD4, tag: 0x40, seed: 0x50534C34, ids: [0, 2, 6, 8, 1, 3, 5, 7], sampleStep: 1.5, sampleOffset: 0.5 }],
    [5, { version: 5, cell: 5, columns: 10, rows: 10, width: 50, height: 50,
      magic: 0xD5, tag: 0x50, seed: 0x50534C35, ids: [0, 2, 6, 8], sampleStep: 1.25, sampleOffset: 0.125 }],
    [6, { version: 6, cell: 5, columns: 10, rows: 10, width: 50, height: 50,
      magic: 0xD6, tag: 0x60, seed: 0x50534C36, ids: [0, 2, 6, 8], sampleStep: 1.25, sampleOffset: 0.125 }]
  ]);
  for (const p of LOCATOR_PROFILES.values()) {
    p.reserveWidth = Math.ceil(p.width / 4) * 4;
    p.reserveHeight = Math.ceil(p.height / 4) * 4;
    p.order = scatterOrder(p.columns * p.rows, p.seed);
    p.shape = buildShapes(LOCATOR_STRENGTH).difference;
    if (p.version !== CARRIER_V3) {
      // Retain V3's expansion for V4; V5 interpolates a smaller cell. Remove
      // DC before writing so the bit does not set the local background brightness.
      p.kernels = [0, 1].map((bit) => {
        const weights = new Float64Array(p.cell * p.cell);
        for (let y = 0; y < p.cell; y++) for (let x = 0; x < p.cell; x++) {
          if (p.version === CARRIER_V4) {
            // Keep V3's six-pixel expansion and full contrast. Only its DC
            // component changes; the diagonal difference reader rejects DC.
            weights[x + y * p.cell] = shapeWeight(Math.floor(x * 4 / p.cell), Math.floor(y * 4 / p.cell), bit);
            continue;
          }
          const sx = Math.max(0, Math.min(3, (x + 0.5) * 4 / p.cell - 0.5));
          const sy = Math.max(0, Math.min(3, (y + 0.5) * 4 / p.cell - 0.5));
          const ix = Math.floor(sx), iy = Math.floor(sy), jx = Math.min(3, ix + 1), jy = Math.min(3, iy + 1);
          const fx = sx - ix, fy = sy - iy;
          weights[x + y * p.cell] = (shapeWeight(ix, iy, bit) * (1 - fx) + shapeWeight(jx, iy, bit) * fx) * (1 - fy) +
            (shapeWeight(ix, jy, bit) * (1 - fx) + shapeWeight(jx, jy, bit) * fx) * fy;
        }
        const mean = weights.reduce((sum, value) => sum + value, 0) / weights.length;
        return weights.map((value) => value - mean);
      });
    }
  }

  function locatorProfile(version = CARRIER_V6) { return LOCATOR_PROFILES.get(version); }

  function referenceLayout(width, height, columns = 4) {
    if (!columns) return [];
    const patchWidth = columns * 4;
    const middleX = Math.floor((width - patchWidth) / 8) * 4, middleY = Math.floor((height - 16) / 8) * 4;
    return [{ id: 1, x: middleX, y: 8 }, { id: 3, x: 8, y: middleY },
      { id: 5, x: Math.floor((width - patchWidth - 8) / 4) * 4, y: middleY },
      { id: 7, x: middleX, y: Math.floor((height - 24) / 4) * 4 }];
  }

  function locatorArea(version, edgeMarkerColumns = version === CARRIER_V6 ? 4 : 6) {
    const p = locatorProfile(version);
    return p.ids.length * p.reserveWidth * p.reserveHeight + (compactCarrier(version) ? 4 * edgeMarkerColumns * 4 * 16 : 0);
  }

  function reservedLocators(width, height, version, edgeMarkerColumns = version === CARRIER_V6 ? 4 : 6) {
    const p = locatorProfile(version);
    return locatorLayout(width, height, version).map((patch) => ({ ...patch, width: p.reserveWidth, height: p.reserveHeight }))
      .concat(compactCarrier(version) ? referenceLayout(width, height, edgeMarkerColumns).map((patch) => ({ ...patch, width: edgeMarkerColumns * 4, height: 16 })) : []);
  }

  function locatorLayout(width, height, version = CARRIER_V6) {
    const p = locatorProfile(version), span = compactCarrier(version) ? 2 : 3;
    // Compact carriers also leave room between corners for small side references.
    if (!p || width < span * p.reserveWidth + 2 * LOCATOR_INSET + (compactCarrier(version) ? 24 : 0) ||
      height < span * p.reserveHeight + 2 * LOCATOR_INSET + (compactCarrier(version) ? 16 : 0)) return null;
    const xs = [LOCATOR_INSET, Math.floor((width - p.reserveWidth) / 8) * 4, Math.floor((width - p.reserveWidth - LOCATOR_INSET) / 4) * 4];
    const ys = [LOCATOR_INSET, Math.floor((height - p.reserveHeight) / 8) * 4, Math.floor((height - p.reserveHeight - LOCATOR_INSET) / 4) * 4];
    return p.ids.map((id) => ({ x: xs[id % 3], y: ys[Math.floor(id / 3)], id }));
  }

  function locatorFits(width, height, version = CARRIER_V6) {
    const p = locatorProfile(version);
    // Small pictures use carrier 1 rather than sacrifice most of their capacity.
    return Boolean(p) && width <= 65535 && height <= 65535 && Boolean(locatorLayout(width, height, version)) &&
      width * height <= MAX_PIXELS && locatorArea(version) <= width * height * 0.3;
  }

  function locatorBlockMap(width, height, limit = Infinity, version = CARRIER_V6, edgeMarkerColumns = version === CARRIER_V6 ? 4 : 6) {
    const layout = locatorLayout(width, height, version);
    if (!layout) return null;
    if (version === CARRIER_V6 && edgeMarkerColumns === 0) {
      // Keep the existing preamble positions. Its CRC-protected magic selects
      // this layout before the reader needs the newly available midpoint cells.
      const existing = locatorBlockMap(width, height, limit, version);
      const columns = Math.floor(width / BLOCK), rows = Math.floor(height / BLOCK);
      if (existing.length === limit) return existing;
      const map = new Uint32Array(Math.min(limit, columns * rows - locatorArea(version, edgeMarkerColumns) / 16));
      map.set(existing);
      let count = existing.length;
      for (const patch of referenceLayout(width, height)) for (let y = 0; y < 16; y += BLOCK) for (let x = 0; x < 16; x += BLOCK) {
        if (count === map.length) return map;
        map[count++] = (patch.x + x) / BLOCK + (patch.y + y) / BLOCK * columns;
      }
      return map;
    }
    const reserved = reservedLocators(width, height, version, edgeMarkerColumns);
    const columns = Math.floor(width / BLOCK), rows = Math.floor(height / BLOCK);
    const map = new Uint32Array(Math.min(limit, columns * rows - locatorArea(version, edgeMarkerColumns) / 16));
    let count = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = column * BLOCK, y = row * BLOCK;
        if (!reserved.some((patch) => x >= patch.x && x < patch.x + patch.width && y >= patch.y && y < patch.y + patch.height)) {
          map[count++] = column + row * columns;
          if (count === map.length) return map;
        }
      }
    }
    return map;
  }

  function locatorHeader(width, height, id, version = CARRIER_V6) {
    const p = locatorProfile(version);
    const bytes = new Uint8Array(8);
    bytes[0] = p.magic;
    bytes[1] = p.tag | id;
    bytes[2] = width & 255; bytes[3] = width >>> 8;
    bytes[4] = height & 255; bytes[5] = height >>> 8;
    const checksum = crc32(bytes, 0, 6) & 0xFFFF;
    bytes[6] = checksum & 255; bytes[7] = checksum >>> 8;
    scramble(bytes, p.seed);
    return bytes;
  }

  function paintLocators(reference, output, width, height, strength, version = CARRIER_V6, signalPolicy) {
    if (version !== CARRIER_V3) return paintBlendedLocators(reference, output, width, height, strength, version, signalPolicy);
    const p = locatorProfile(version);
    const amplitude = Math.min(LOCATOR_STRENGTH, strength);
    for (const patch of locatorLayout(width, height, version)) {
      const header = locatorHeader(width, height, patch.id, version);
      for (let slot = 0; slot < 96; slot++) {
        const cell = p.order[slot];
        const bit = WORD_BITS[header[Math.floor(slot / 12)] * 12 + slot % 12];
        const x = patch.x + (cell % p.columns) * p.cell;
        const y = patch.y + Math.floor(cell / p.columns) * p.cell;
        for (let channel = 0; channel < 3; channel++) {
          let low = -Infinity, high = Infinity;
          for (let dy = 0; dy < p.cell; dy++) for (let dx = 0; dx < p.cell; dx++) {
            const delta = scaleWeight(amplitude, shapeWeight(Math.floor(dx * 4 / p.cell), Math.floor(dy * 4 / p.cell), bit));
            const value = reference[(x + dx + (y + dy) * width) * 4 + channel];
            low = Math.max(low, -value - delta);
            high = Math.min(high, 255 - value - delta);
          }
          const bias = low <= high ? Math.max(low, Math.min(high, 0)) : 0;
          for (let dy = 0; dy < p.cell; dy++) for (let dx = 0; dx < p.cell; dx++) {
            const index = (x + dx + (y + dy) * width) * 4 + channel;
            output[index] = clampByte(reference[index] + bias + scaleWeight(amplitude, shapeWeight(Math.floor(dx * 4 / p.cell), Math.floor(dy * 4 / p.cell), bit)));
          }
        }
      }
    }
  }

  function locatorGain(p, cell) {
    const x = cell % p.columns, y = Math.floor(cell / p.columns);
    return (x === 0 || x === p.columns - 1 ? 0.7 : 1) * (y === 0 || y === p.rows - 1 ? 0.7 : 1);
  }

  const sideReferenceProfiles = new Map();
  function referenceProfile(version = CARRIER_V6, columns = version === CARRIER_V6 ? 4 : 6) {
    const key = version + ":" + columns;
    if (!sideReferenceProfiles.has(key)) sideReferenceProfiles.set(key, { cell: 4, columns, rows: 4, width: columns * 4, height: 16,
      order: scatterOrder(columns * 4, locatorProfile(version).seed), sampleStep: 1, sampleOffset: 0,
      shape: buildShapes(16).difference,
      kernels: [0, 1].map((bit) => Float64Array.from({ length: 16 }, (_, i) => shapeWeight(i % 4, Math.floor(i / 4), bit))) });
    return sideReferenceProfiles.get(key);
  }

  function referenceBit(header, slot, columns = 6) {
    // The square retains the first coded byte and the four corner-relative ID
    // bits of the second byte. It is a known diagnostic pattern, not a payload.
    const coded = columns === 4 && slot >= 12 ? slot + 4 : slot;
    return WORD_BITS[header[Math.floor(coded / 12)] * 12 + coded % 12];
  }

  function patchTransform(matrix, patch) {
    return [matrix[0], matrix[1], matrix[2] + matrix[0] * patch.x + matrix[1] * patch.y,
      matrix[3], matrix[4], matrix[5] + matrix[3] * patch.x + matrix[4] * patch.y,
      matrix[6], matrix[7], matrix[8] + matrix[6] * patch.x + matrix[7] * patch.y];
  }

  function checkReferences(pixels, width, height, matrix, dimensions, nativeOnly = false, version = CARRIER_V6, columns = version === CARRIER_V6 ? 4 : 6) {
    // References are checked only near positions predicted by verified corner
    // geometry. They carry no independent dimensions or checksum and must never
    // be used to claim that an image is encoded, or to accept its payload.
    const found = [];
    for (const patch of referenceLayout(dimensions.originalWidth, dimensions.originalHeight, columns)) {
      const header = locatorHeader(0, 0, patch.id, version);
      const quality = (x, y) => locatorAgreement(locatorScores(pixels, width, height,
        patchTransform(matrix, { x: patch.x + x, y: patch.y + y }), columns * 4, version, columns), header, columns);
      let best = { x: 0, y: 0, quality: quality(0, 0) };
      if (!nativeOnly) {
        for (const y of [-6, -4, -2, 0, 2, 4, 6]) for (const x of [-6, -4, -2, 0, 2, 4, 6]) {
          const q = quality(x, y);
          if (q > best.quality) best = { x, y, quality: q };
        }
        for (const step of [0.5, 0.125]) {
          const start = best;
          for (const y of [-step, 0, step]) for (const x of [-step, 0, step]) {
            const q = quality(start.x + x, start.y + y);
            if (q > best.quality) best = { x: start.x + x, y: start.y + y, quality: q };
          }
        }
      }
      if (best.quality >= 0.82) found.push({ id: patch.id, verification: "reference", quality: best.quality,
        carrierVersion: version, patchWidth: columns * 4, patchHeight: 16,
        matrix: patchTransform(matrix, { x: patch.x + best.x, y: patch.y + best.y }),
        expectedMatrix: patchTransform(matrix, patch), displacement: { x: best.x, y: best.y } });
    }
    return found;
  }

  function blendedLocatorGain(version, grid, cell, main = true) {
    return version === CARRIER_V4 ? 1 : locatorGain(grid, cell) * (main ? 1 : 0.65);
  }

  function markerSignalPolicy(signalPolicy, version, main) {
    if (!signalPolicy || !compactCarrier(version)) return signalPolicy;
    const policy = { ...signalPolicy,
      strength: Math.max(signalPolicy.markerMinimum ?? 12, signalPolicy.strength),
      textureGain: Math.max(signalPolicy.markerTextureMinimum ?? 0.5, signalPolicy.textureGain) };
    // Corners have far fewer repeats than the payload. Keep their existing
    // strength/texture boost and 32-level ceiling, including during local fit.
    return main ? { ...policy,
      strength: Math.min(V5_MARKER_PEAK, Math.round(policy.strength * 4 / 3)),
      textureGain: policy.textureGain * 1.5,
      markerPeak: Math.min(V5_MARKER_PEAK, Math.round(policy.markerPeak * 4 / 3)) } : policy;
  }

  function markerBackground(basis, kernels, requested, preferred, localFit, allowLift) {
    const shifts = new Int16Array(3); if (!localFit) return shifts;
    const count = kernels[0].length;
    for (let c = 0; c < 3; c++) {
      let lower = -Infinity, upper = Infinity;
      for (const kernel of kernels) for (let k = 0; k < count; k++) {
        const value = basis[k * 3 + c] + (allowLift ? requested * kernel[k] : 0);
        lower = Math.max(lower, -value); upper = Math.min(upper, 255 - value);
      }
      lower = Math.ceil(lower); upper = Math.floor(upper);
      if (lower > upper) {
        if (allowLift) return markerBackground(basis, kernels, requested, preferred, localFit, false);
        throw new Error("The V6 marker background cannot fit the channel range.");
      }
      shifts[c] = clampRange(Math.round(preferred[c]), lower, upper);
    }
    return shifts;
  }

  function fitV6MarkerSignal(basis, kernels, gain, redTint, blueTint, shifts) {
    const count = kernels[0].length, deltas = [];
    for (const kernel of kernels) {
      const tint = colourOffsets(kernel, redTint, blueTint, 0, 0, gain);
      const delta = new Float64Array(count * 3); deltas.push(delta);
      for (let k = 0; k < count; k++) for (let c = 0; c < 3; c++) {
        delta[k * 3 + c] = gain * kernel[k] + tint[k * 3 + c];
        const value = basis[k * 3 + c] + shifts[c] + delta[k * 3 + c];
        if (value < -1e-7 || value > 255 + 1e-7) return null;
      }
    }
    return { deltas, shifts };
  }

  function paintV6MarkerCell(colourTarget, output, width, x, y, side, basis, kernels, bit, requested, preferred, localFit, colour, allowLift = false) {
    // Establish and freeze the background first. Extra lift is allowed only
    // after the actual native corner checks have rejected the matched mean.
    const shifts = markerBackground(basis, kernels, requested, preferred, localFit, allowLift);
    const [redTint, blueTint] = colour ? signalTint(colourTarget, width, x, y, side) : [0, 0];
    let gain = requested;
    for (const kernel of kernels) for (let k = 0; k < kernel.length; k++) {
      if (kernel[k] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const value = basis[k * 3 + c] + shifts[c];
        gain = Math.min(gain, kernel[k] > 0 ? (255 - value) / kernel[k] : value / -kernel[k]);
      }
    }
    gain = Math.max(0, gain);
    let fit = null;
    for (const amount of [1, .5, .25, .125, .0625, .03125, 0]) {
      fit = fitV6MarkerSignal(basis, kernels, gain, redTint * amount, blueTint * amount, shifts);
      if (fit) break;
    }
    if (!fit) throw new Error("The V6 marker signal cannot fit its prepared background.");
    const count = side ** 2, values = new Float64Array(count);
    for (let c = 0; c < 3; c++) {
      let sum = 0, written = 0;
      for (let k = 0; k < count; k++) {
        sum += basis[k * 3 + c]; values[k] = basis[k * 3 + c] + shifts[c] + fit.deltas[bit][k * 3 + c];
        const i = (x + k % side + (y + Math.floor(k / side)) * width) * 4 + c;
        output[i] = Math.round(clampByte(values[k])); written += output[i];
      }
      const target = clampRange(Math.round(sum + count * shifts[c]), 0, count * 255);
      while (written !== target) {
        const step = written < target ? 1 : -1; let best = -1, error = -Infinity;
        for (let k = 0; k < count; k++) {
          const i = (x + k % side + (y + Math.floor(k / side)) * width) * 4 + c;
          if (output[i] + step < 0 || output[i] + step > 255) continue;
          const residual = step * (values[k] - output[i]);
          if (residual > error) { best = i; error = residual; }
        }
        if (best < 0) throw new Error('The V6 marker average cannot be preserved.');
        output[best] += step; written += step;
      }
    }
  }

  function paintBlendedLocators(reference, output, width, height, strength, version, signalPolicy) {
    const p = locatorProfile(version), amplitude = Math.min(version === CARRIER_V4 ? LOCATOR_STRENGTH : 12, strength) / 16;
    const markerPolicy = markerSignalPolicy(signalPolicy, version, false), cornerPolicy = markerSignalPolicy(signalPolicy, version, true);
    const edgeMarkerColumns = signalPolicy?.edgeMarkerColumns ?? (version === CARRIER_V6 ? 4 : 6);
    const side = referenceProfile(version, edgeMarkerColumns || 4);
    const reserved = reservedLocators(width, height, version, edgeMarkerColumns);
    // Match the surrounding carrier's DC correction on clipped colours (pure
    // black/white cannot carry a zero-mean mark). Measure only payload pixels,
    // before painting any markers, so patch order never changes the result.
    const backgrounds = new Map(reserved.map((patch) => {
      const bias = [0, 0, 0]; let count = 0;
      for (let y = Math.max(0, patch.y - 12); y < Math.min(height, patch.y + patch.height + 12); y++) {
        for (let x = Math.max(0, patch.x - 12); x < Math.min(width, patch.x + patch.width + 12); x++) {
          if (reserved.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
          const index = (x + y * width) * 4;
          for (let c = 0; c < 3; c++) bias[c] += output[index + c] - reference[index + c];
          count++;
        }
      }
      return [patch.id, bias.map((value) => count ? value / count : 0)];
    }));
    // Give any aligned reservation margin the same background correction,
    // avoiding a bright/dark outline; cells below supply the actual signal.
    for (const patch of reserved) for (let y = patch.y; y < patch.y + patch.height; y++) {
      for (let x = patch.x; x < patch.x + patch.width; x++) {
        const index = (x + y * width) * 4;
        for (let c = 0; c < 3; c++) output[index + c] = Math.round(clampByte(reference[index + c] + backgrounds.get(patch.id)[c]));
      }
    }
    const patches = locatorLayout(width, height, version).concat(compactCarrier(version) ? referenceLayout(width, height, edgeMarkerColumns) : []);
    for (const patch of patches) {
      const main = p.ids.includes(patch.id), grid = main ? p : side, count = grid.cell ** 2;
      const policy = main ? cornerPolicy : markerPolicy;
      const samples = new Float64Array(count), values = new Float64Array(count);
      const header = locatorHeader(width, height, patch.id, version);
      for (let slot = 0; slot < grid.order.length; slot++) {
        const cell = grid.order[slot], coded = slot % (main ? 96 : 24);
        const bit = main ? WORD_BITS[header[Math.floor(coded / 12)] * 12 + coded % 12] : referenceBit(header, slot, edgeMarkerColumns);
        const x = patch.x + cell % grid.columns * grid.cell, y = patch.y + Math.floor(cell / grid.columns) * grid.cell;
        const localAmplitude = policy ? textureAmplitude(policy.textureSource || reference, width, x, y,
          grid.cell, policy, policy.markerPeak) / 16 : amplitude;
        const requested = localAmplitude * blendedLocatorGain(version, grid, cell, main);
        if (version === CARRIER_V6) {
          const basis = new Float64Array(count * 3);
          for (let k = 0; k < count; k++) for (let c = 0; c < 3; c++)
            basis[k * 3 + c] = reference[(x + k % grid.cell + (y + Math.floor(k / grid.cell)) * width) * 4 + c];
          paintV6MarkerCell(signalPolicy?.colourSource || signalPolicy?.textureSource || reference, output, width, x, y, grid.cell, basis,
            grid.kernels, bit, requested, backgrounds.get(patch.id), Boolean(signalPolicy?.localFit), Boolean(signalPolicy?.colourWavelets));
          continue;
        }
        let gain = requested;
        if (signalPolicy?.rangeHeadroom || signalPolicy?.localFit) gain = linearMarkerGain(reference, width, x, y, grid, gain);
        const kernel = grid.kernels[bit];
        for (let channel = 0; channel < 3; channel++) {
          let target = 0;
          for (let i = 0; i < count; i++) {
            samples[i] = reference[(x + i % grid.cell + (y + Math.floor(i / grid.cell)) * width) * 4 + channel];
            target += samples[i];
          }
          target = Math.max(0, Math.min(count * 255, Math.round(target + count * backgrounds.get(patch.id)[channel])));
          // Saturated pixels have no symmetric headroom. Solve the clamped mean
          // rather than shifting the whole patch lighter/darker to fit a lobe.
          let low = -64, high = 64;
          for (let pass = 0; !signalPolicy?.rangeHeadroom && !signalPolicy?.localFit && pass < 18; pass++) {
            const shift = (low + high) / 2;
            let total = 0;
            for (let i = 0; i < count; i++) total += clampByte(samples[i] + gain * kernel[i] + shift);
            if (total < target) low = shift; else high = shift;
          }
          const shift = signalPolicy?.rangeHeadroom || signalPolicy?.localFit ? 0 : (low + high) / 2;
          let written = 0;
          for (let i = 0; i < count; i++) {
            values[i] = clampByte(samples[i] + gain * kernel[i] + shift);
            const index = (x + i % grid.cell + (y + Math.floor(i / grid.cell)) * width) * 4 + channel;
            output[index] = Math.round(values[i]); written += output[index];
          }
          // Quantisation also preserves the chosen local background average.
          while (written !== target) {
            const step = written < target ? 1 : -1;
            let best = -1, error = -Infinity;
            for (let i = 0; i < count; i++) {
              const index = (x + i % grid.cell + (y + Math.floor(i / grid.cell)) * width) * 4 + channel;
              if (output[index] + step < 0 || output[index] + step > 255) continue;
              const residual = step * (values[i] - output[index]);
              if (residual > error) { best = index; error = residual; }
            }
            if (best < 0) break;
            output[best] += step; written += step;
          }
        }
      }
    }
  }

  function sampleLuma(pixels, width, height, x, y, channel) {
    x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = (x0 + y0 * width) * 4, b = (x1 + y0 * width) * 4;
    const c = (x0 + y1 * width) * 4, d = (x1 + y1 * width) * 4;
    if (channel !== undefined) return pixels[a + channel] * (1 - fx) * (1 - fy) + pixels[b + channel] * fx * (1 - fy) +
      pixels[c + channel] * (1 - fx) * fy + pixels[d + channel] * fx * fy;
    return ((pixels[a] + pixels[a + 1] + pixels[a + 2]) * (1 - fx) * (1 - fy) +
      (pixels[b] + pixels[b + 1] + pixels[b + 2]) * fx * (1 - fy) +
      (pixels[c] + pixels[c + 1] + pixels[c + 2]) * (1 - fx) * fy +
      (pixels[d] + pixels[d + 1] + pixels[d + 2]) * fx * fy) / 3;
  }

  function nativeLocatorCellScore(pixels, width, height, x, y, profile) {
    let projection = 0, sum = 0, squares = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const value = sampleLuma(pixels, width, height, x + profile.sampleStep * dx + profile.sampleOffset,
        y + profile.sampleStep * dy + profile.sampleOffset);
      projection += value * profile.shape[dx + dy * 4]; sum += value; squares += value * value;
    }
    return projection / Math.sqrt(400 + Math.max(0, squares - sum * sum / 16));
  }

  function repairV5LocatorCell(reference, output, width, height, x, y, profile, cell, bit, signalPolicy = null) {
    const count = profile.cell ** 2, kernel = profile.kernels[bit], sign = bit ? 1 : -1;
    const means = new Float64Array(3), targets = new Uint32Array(3);
    const source = new Float64Array(count * 3), base = new Float64Array(source.length), values = new Float64Array(source.length);
    for (let i = 0; i < count; i++) {
      const index = (x + i % profile.cell + (y + Math.floor(i / profile.cell)) * width) * 4;
      for (let c = 0; c < 3; c++) { source[i * 3 + c] = reference[index + c]; means[c] += reference[index + c]; targets[c] += output[index + c]; }
    }
    for (let c = 0; c < 3; c++) means[c] /= count;
    // First raise the signal within its existing peak/taper limit. Only if
    // source detail still wins, reduce this cell's contrast around the SAME
    // RGB average. Always repaint from the untouched working reference.
    for (const contrast of [1, .75, .5, .25, 0]) {
      if (profile.version === CARRIER_V6) {
        for (let k = 0; k < count; k++) for (let c = 0; c < 3; c++)
          base[k * 3 + c] = means[c] + contrast * (source[k * 3 + c] - means[c]);
        const preferred = Array.from(targets, (target, c) => target / count - means[c]);
        paintV6MarkerCell(signalPolicy?.colourSource || signalPolicy?.textureSource || reference, output, width, x, y, profile.cell, base,
          profile.kernels, bit, V5_MARKER_PEAK / 16 * locatorGain(profile, cell), preferred,
          Boolean(signalPolicy?.localFit), Boolean(signalPolicy?.colourWavelets));
        if (sign * nativeLocatorCellScore(output, width, height, x, y, profile) >= V5_MARKER_NATIVE_FLOOR) return true;
        continue;
      }
      for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++)
        base[i * 3 + c] = targets[c] / count + contrast * (source[i * 3 + c] - means[c]);
      let gain = V5_MARKER_PEAK / 16 * locatorGain(profile, cell);
      for (const shape of profile.kernels) for (let i = 0; i < count; i++) {
        if (shape[i] === 0) continue;
        for (let c = 0; c < 3; c++) {
          const sample = base[i * 3 + c];
          gain = Math.min(gain, shape[i] > 0 ? (255 - sample) / shape[i] : sample / -shape[i]);
        }
      }
      gain = Math.max(0, gain);
      for (let c = 0; c < 3; c++) {
        let written = 0;
        for (let i = 0; i < count; i++) {
          const index = (x + i % profile.cell + (y + Math.floor(i / profile.cell)) * width) * 4 + c;
          values[i * 3 + c] = clampByte(base[i * 3 + c] + gain * kernel[i]);
          output[index] = Math.round(values[i * 3 + c]); written += output[index];
        }
        // Preserve the original painted cell's exact integer channel sums.
        while (written !== targets[c]) {
          const step = written < targets[c] ? 1 : -1;
          let best = -1, error = -Infinity;
          for (let i = 0; i < count; i++) {
            const index = (x + i % profile.cell + (y + Math.floor(i / profile.cell)) * width) * 4 + c;
            if (output[index] + step < 0 || output[index] + step > 255) continue;
            const residual = step * (values[i * 3 + c] - output[index]);
            if (residual > error) { best = index; error = residual; }
          }
          if (best < 0) return false;
          output[best] += step; written += step;
        }
      }
      if (sign * nativeLocatorCellScore(output, width, height, x, y, profile) >= V5_MARKER_NATIVE_FLOOR) return true;
    }
    if (profile.version === CARRIER_V6 && signalPolicy?.localFit) {
      // Preserve the unchanged native score threshold: extra DC is a last
      // resort after every contrast candidate at the matched mean has failed.
      const preferred = Array.from(targets, (target, c) => target / count - means[c]);
      for (const scale of [.25, .5, .75, 1]) for (const contrast of [1, .75, .5, .25, 0]) {
        for (let k = 0; k < count; k++) for (let c = 0; c < 3; c++)
          base[k * 3 + c] = means[c] + contrast * (source[k * 3 + c] - means[c]);
        paintV6MarkerCell(signalPolicy?.colourSource || signalPolicy?.textureSource || reference, output, width, x, y, profile.cell, base, profile.kernels, bit,
          scale * V5_MARKER_PEAK / 16 * locatorGain(profile, cell), preferred, true, Boolean(signalPolicy.colourWavelets), true);
        if (sign * nativeLocatorCellScore(output, width, height, x, y, profile) >= V5_MARKER_NATIVE_FLOOR) {
          signalPolicy.liftedCornerCells++; return true;
        }
      }
    }
    return false;
  }

  function verifyAndRepairCompactLocators(reference, output, width, height, version, signalPolicy) {
    if (version === CARRIER_V6 && signalPolicy) signalPolicy.liftedCornerCells = 0;
    const profile = locatorProfile(version), layout = locatorLayout(width, height, version);
    if (!layout) return false;
    for (const patch of layout) {
      const matrix = [1, 0, patch.x, 0, 1, patch.y, 0, 0, 1], header = locatorHeader(width, height, patch.id, version);
      const scores = locatorScores(output, width, height, matrix, profile.order.length, version);
      if (!scores) return false;
      for (let slot = 0; slot < scores.length; slot++) {
        const coded = slot % 96, bit = WORD_BITS[header[Math.floor(coded / 12)] * 12 + coded % 12];
        if (scores[slot] * (bit ? 1 : -1) >= V5_MARKER_NATIVE_FLOOR) continue;
        const cell = profile.order[slot], x = patch.x + cell % profile.columns * profile.cell;
        const y = patch.y + Math.floor(cell / profile.columns) * profile.cell;
        if (!repairV5LocatorCell(reference, output, width, height, x, y, profile, cell, bit, signalPolicy)) return false;
      }
      // Use the actual reader too: signal scores alone cannot establish a
      // marker ID, dimensions or CRC. Header bytes/layout are unchanged.
      const read = readVisualLocator(output, width, height, matrix, patch.id, version);
      if (!read || read.originalWidth !== width || read.originalHeight !== height) return false;
    }
    return true;
  }

  function readLocator(pixels, width, height, x, y, scaleX, scaleY, id, version = CARRIER_V6) {
    const p = locatorProfile(version);
    if (x < -2 || y < -2 || x + (p.width - 1) * scaleX > width + 1 || y + (p.height - 1) * scaleY > height + 1) return null;
    const known = locatorHeader(0, 0, id, version);
    const scores = new Float64Array(96);
    let pilot = 0, pilotEnergy = 0;
    for (let slot = 0; slot < 96; slot++) {
      const cell = p.order[slot];
      const originX = x + cell % p.columns * p.cell * scaleX;
      const originY = y + Math.floor(cell / p.columns) * p.cell * scaleY;
      let projection = 0, sum = 0, squares = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const value = sampleLuma(pixels, width, height, originX + (p.sampleStep * dx + p.sampleOffset) * scaleX, originY + (p.sampleStep * dy + p.sampleOffset) * scaleY);
        projection += value * p.shape[dx + dy * 4]; sum += value; squares += value * value;
      }
      const score = projection / Math.sqrt(400 + Math.max(0, squares - sum * sum / 16));
      scores[slot] = score;
      if (slot < 24) {
        pilot += score * (WORD_BITS[known[Math.floor(slot / 12)] * 12 + slot % 12] ? 1 : -1);
        pilotEnergy += Math.abs(score);
        if (slot === 23 && (pilotEnergy === 0 || pilot / pilotEnergy < 0.55)) return null;
      }
    }
    const bytes = decodeSoft(scores, 8).bytes;
    scramble(bytes, p.seed);
    if (bytes[0] !== p.magic || bytes[1] !== (p.tag | id) || (crc32(bytes, 0, 6) & 0xFFFF) !== (bytes[6] | bytes[7] << 8)) return null;
    const originalWidth = bytes[2] | bytes[3] << 8, originalHeight = bytes[4] | bytes[5] << 8;
    if (!locatorFits(originalWidth, originalHeight, version)) return null;
    const actualX = width / originalWidth, actualY = height / originalHeight;
    if (actualX < 0.49 || actualX > 2.01 || actualY < 0.49 || actualY > 2.01 ||
      Math.abs(actualX - scaleX) > 0.04 || Math.abs(actualY - scaleY) > 0.04) return null;
    return { originalWidth, originalHeight, carrierVersion: version, id, quality: pilot / pilotEnergy };
  }

  function mappedPoint(matrix, x, y) {
    const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
    return { x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
      y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator };
  }

  function locatorScores(pixels, width, height, matrix, count = 96, version = CARRIER_V6, reference = false) {
    const p = reference ? referenceProfile(version, typeof reference === "number" ? reference : version === CARRIER_V6 ? 4 : 6) : locatorProfile(version);
    // The patch matrix maps its own pixel centres into the supplied image.
    for (const [x, y] of [[0, 0], [p.width - 1, 0], [0, p.height - 1], [p.width - 1, p.height - 1]]) {
      const point = mappedPoint(matrix, x, y);
      if (!Number.isFinite(point.x + point.y) || point.x < -0.5 || point.y < -0.5 || point.x > width - 0.5 || point.y > height - 0.5) return null;
    }
    const scores = new Float64Array(count);
    for (let slot = 0; slot < count; slot++) {
      const cell = p.order[slot], x = cell % p.columns * p.cell, y = Math.floor(cell / p.columns) * p.cell;
      let projection = 0, sum = 0, squares = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const point = mappedPoint(matrix, x + p.sampleStep * dx + p.sampleOffset, y + p.sampleStep * dy + p.sampleOffset);
        const value = sampleLuma(pixels, width, height, point.x, point.y);
        projection += value * p.shape[dx + dy * 4]; sum += value; squares += value * value;
      }
      scores[slot] = projection / Math.sqrt(400 + Math.max(0, squares - sum * sum / 16));
    }
    return scores;
  }

  function locatorAgreement(scores, header, columns = 6) {
    if (!scores) return -Infinity;
    let agreement = 0, energy = 0;
    for (let slot = 0; slot < scores.length; slot++) {
      agreement += scores[slot] * (referenceBit(header, slot, columns) ? 1 : -1);
      energy += Math.abs(scores[slot]);
    }
    // Do not reward an almost empty response just because its signs agree.
    return energy ? agreement / energy * Math.min(1, energy / (scores.length * 12)) : -Infinity;
  }

  function readVisualLocator(pixels, width, height, matrix, id, version = CARRIER_V6) {
    const p = locatorProfile(version);
    const scores = locatorScores(pixels, width, height, matrix, 96, version);
    if (!scores || locatorAgreement(scores.subarray(0, 24), locatorHeader(0, 0, id, version)) < 0.55) return null;
    const bytes = decodeSoft(scores, 8).bytes;
    scramble(bytes, p.seed);
    if (bytes[0] !== p.magic || bytes[1] !== (p.tag | id) || (crc32(bytes, 0, 6) & 0xFFFF) !== (bytes[6] | bytes[7] << 8)) return null;
    const originalWidth = bytes[2] | bytes[3] << 8, originalHeight = bytes[4] | bytes[5] << 8;
    if (!locatorFits(originalWidth, originalHeight, version)) return null;
    // Supplied image bounds say nothing about encoded bounds once there is padding.
    return { originalWidth, originalHeight, carrierVersion: version, patchWidth: p.width, patchHeight: p.height, id, matrix: Array.from(matrix),
      verification: "header", quality: locatorAgreement(scores, locatorHeader(originalWidth, originalHeight, id, version)) };
  }

  function visualAdapter(pixels, width, height, version = CARRIER_V6) {
    const p = locatorProfile(version), ids = p.ids;
    return {
      carrierVersion: version, patchWidth: p.width, patchHeight: p.height,
      sampleStep: p.sampleStep, sampleOffset: p.sampleOffset,
      shape: Array.from(p.shape), ids,
      pilots: ids.map((id) => {
        const header = locatorHeader(0, 0, id, version);
        return { id, points: Array.from({ length: 24 }, (_, slot) => {
          const cell = p.order[slot];
          return { x: cell % p.columns * p.cell, y: Math.floor(cell / p.columns) * p.cell,
            sign: WORD_BITS[header[Math.floor(slot / 12)] * 12 + slot % 12] ? 1 : -1 };
        }) };
      }),
      layout: (w, h) => locatorLayout(w, h, version),
      references: compactCarrier(version) ? (matrix, dimensions) => checkReferences(pixels, width, height, matrix, dimensions, false, version) : undefined,
      read: (matrix, id) => readVisualLocator(pixels, width, height, matrix, id, version),
      confirm: (matrix, id, dimensions) => {
        const read = readVisualLocator(pixels, width, height, matrix, id, version);
        if (read && read.originalWidth === dimensions.originalWidth && read.originalHeight === dimensions.originalHeight) return read;
        // Once dimensions are known, compare all 96 expected symbols. A damaged
        // header can still supply geometry; acceptance of contents needs frame CRC.
        const scores = locatorScores(pixels, width, height, matrix, 96, version);
        const header = locatorHeader(dimensions.originalWidth, dimensions.originalHeight, id, version);
        const quality = locatorAgreement(scores, header);
        if (quality < 0.58 || !scores || locatorAgreement(scores.subarray(0, 24), header) < 0.4) return null;
        return { originalWidth: dimensions.originalWidth, originalHeight: dimensions.originalHeight,
          carrierVersion: version, patchWidth: p.width, patchHeight: p.height, id, matrix: Array.from(matrix), quality, verification: "pattern" };
      },
      quality: (matrix, id, dimensions) => locatorAgreement(locatorScores(pixels, width, height, matrix, dimensions ? 96 : 24, version),
        locatorHeader(dimensions?.originalWidth || 0, dimensions?.originalHeight || 0, id, version))
    };
  }

  async function findLocator(pixels, width, height, nativeOnly = false, quickOnly = false, signal, options = {}) {
    const scales = nativeOnly ? [1] : quickOnly ? [0.95, 2, 0.5, 1.05, 0.75, 1.5, 1.25] : [0.95, 2, 0.5, 1.05, 0.75, 1.5, 1.25, 1];
    if (!nativeOnly && !quickOnly) {
      for (let i = 20; i <= 80; i++) {
        const scale = i / 40;
        if (!scales.includes(scale)) scales.push(scale);
      }
    }
    const offsets = nativeOnly ? [0] : quickOnly ? [0, -0.5, 0.5] : [0, -0.5, 0.5, -1, 1];
    for (const version of recoveryVersions(options).filter((version) => locatorProfile(version))) for (const scale of scales) {
      if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      const guessedWidth = Math.round(width / scale), guessedHeight = Math.round(height / scale);
      const layout = locatorLayout(guessedWidth, guessedHeight, version);
      if (!layout || !locatorFits(guessedWidth, guessedHeight, version)) continue;
      for (const id of locatorProfile(version).ids) {
        const patch = layout.find((patch) => patch.id === id);
        for (const oy of offsets) for (const ox of offsets) {
          const found = readLocator(pixels, width, height, patch.x * scale + (scale - 1) / 2 + ox, patch.y * scale + (scale - 1) / 2 + oy, scale, scale, id, version);
          if (found && (!nativeOnly || (found.originalWidth === width && found.originalHeight === height))) return found;
        }
      }
      await yieldNow();
    }
    return null;
  }

  async function scoreMapped(pixels, width, height, map, originalWidth, strength, fit, limit = map.length, signal = fit?.signal) {
    checkCancelled(signal);
    const scores = new Int32Array(limit), bounded = new Int32Array(limit);
    const difference = buildShapes(strength).difference;
    const columns = Math.floor(originalWidth / BLOCK);
    let differenceEnergy = 0;
    for (const value of difference) differenceEnergy += value * value;
    const block = new Float64Array(16);
    const half = fit && !fit.matrix && Math.abs(fit.scaleX - 0.5) < 0.001 && Math.abs(fit.scaleY - 0.5) < 0.001;
    for (let i = 0; i < limit; i++) {
      if ((i & 8191) === 8191) {
        await yieldNow();
        checkCancelled(signal);
      }
      const x = (map[i] % columns) * BLOCK, y = Math.floor(map[i] / columns) * BLOCK;
      if (half) {
        // An aligned 2x2 average retains the two diagonal signs. Score that
        // reduced symbol directly instead of blurring it back into 4x4 pixels.
        let projection = 0, sum = 0, squares = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const value = sampleLuma(pixels, width, height, fit.scaleX * (x + 2 * dx + 0.5) + fit.phaseX, fit.scaleY * (y + 2 * dy + 0.5) + fit.phaseY);
          projection += value * (dx === dy ? 1 : -1); sum += value; squares += value * value;
        }
        scores[i] = bounded[i] = roundHalfToEven(100 * projection / Math.sqrt(25 + Math.max(0, squares - sum * sum / 4)));
        continue;
      }
      let projection = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const k = dx + dy * 4;
        const pixel = (x + dx + (y + dy) * width) * 4;
        if (fit?.matrix) {
          const point = mappedPoint(fit.matrix, x + dx, y + dy);
          block[k] = sampleLuma(pixels, width, height, point.x, point.y, fit.channel);
        } else {
          block[k] = fit ? sampleLuma(pixels, width, height, fit.scaleX * (x + dx) + fit.phaseX, fit.scaleY * (y + dy) + fit.phaseY, fit.channel)
            : (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3;
        }
        projection += block[k] * difference[k];
      }
      let noiseEnergy = 25;
      for (const kernel of NOISE_KERNELS) {
        let coefficient = 0;
        for (let k = 0; k < 16; k++) coefficient += block[k] * kernel[k];
        noiseEnergy += coefficient * coefficient;
      }
      scores[i] = roundHalfToEven(100 * projection / Math.sqrt(noiseEnergy));
      bounded[i] = roundHalfToEven(100 * Math.max(-differenceEnergy / 2, Math.min(differenceEnergy / 2, projection)) / 5);
    }
    return { scores, bounded };
  }

  async function readMapped(pixels, width, height, record, native = false, signal, failure = { stage: "markers" }) {
    recordReadFailure(failure, { stage: "wavelets" });
    const originalWidth = record.originalWidth, originalHeight = record.originalHeight;
    const version = record.carrierVersion || CARRIER_V6;
    const preambleMap = locatorBlockMap(originalWidth, originalHeight, PREAMBLE_BLOCKS, version);
    const scaleX = width / originalWidth, scaleY = height / originalHeight;
    const offsets = native ? [0] : [0, -0.25, 0.25, -0.5, 0.5, -1, 1];
    for (const oy of offsets) for (const ox of offsets) {
      if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      const fit = native ? null : { scaleX, scaleY, phaseX: (scaleX - 1) / 2 + ox, phaseY: (scaleY - 1) / 2 + oy, signal };
      for (const strength of STRENGTHS) {
        const probe = await scoreMapped(pixels, width, height, preambleMap, originalWidth, strength, fit, PREAMBLE_BLOCKS, signal);
        const preamble = tryReadPreamble(probe.scores) || tryReadPreamble(probe.bounded);
        if (!preamble || preamble.version !== version) continue;
        const map = locatorBlockMap(originalWidth, originalHeight, Infinity, version, preamble.edgeMarkerColumns);
        const layout = { map, width: originalWidth, height: originalHeight };
        const scored = await scoreMapped(pixels, width, height, map, originalWidth, strength, fit, map.length, signal);
        const found = (await tryLayout(scored.scores, signal, failure, layout)) || (await tryLayout(scored.bounded, signal, failure, layout));
        if (found && found.carrierVersion === version) return {
          ...found, origWidth: originalWidth, origHeight: originalHeight,
          scaleX, scaleY, phaseX: fit?.phaseX || 0, phaseY: fit?.phaseY || 0
        };
      }
      if (!native) await yieldNow();
    }
    return { locatorOnly: true, carrierVersion: version, origWidth: originalWidth, origHeight: originalHeight, scaleX, scaleY, failure };
  }

  async function readVisualMapping(pixels, width, height, geometry, signal, readOptions = {}) {
    const failure = readOptions.failure || { stage: "wavelets" };
    recordReadFailure(failure, { stage: "wavelets" });
    const version = geometry.carrierVersion || CARRIER_V6;
    const preambleMap = locatorBlockMap(geometry.originalWidth, geometry.originalHeight, PREAMBLE_BLOCKS, version);
    const offsets = readOptions.offsets || [0, -0.25, 0.25, -0.5, 0.5];
    for (const oy of offsets) for (const ox of offsets) {
      if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      const matrix = geometry.matrix.slice();
      // Offset in observed space, including the projective denominator.
      for (let i = 0; i < 3; i++) { matrix[i] += ox * matrix[i + 6]; matrix[i + 3] += oy * matrix[i + 6]; }
      let fit = { matrix, signal, channel: readOptions.channel };
      if (Math.abs(matrix[1]) < 1e-12 && Math.abs(matrix[3]) < 1e-12 && Math.abs(matrix[6]) + Math.abs(matrix[7]) < 1e-12) {
        fit = { scaleX: matrix[0] / matrix[8], scaleY: matrix[4] / matrix[8], phaseX: matrix[2] / matrix[8], phaseY: matrix[5] / matrix[8], signal, channel: readOptions.channel };
      }
      for (const strength of readOptions.strengths || STRENGTHS) {
        const probe = await scoreMapped(pixels, width, height, preambleMap, geometry.originalWidth, strength, fit, PREAMBLE_BLOCKS);
        const preamble = tryReadPreamble(probe.scores) || tryReadPreamble(probe.bounded);
        if (!preamble || preamble.version !== version) continue;
        const map = locatorBlockMap(geometry.originalWidth, geometry.originalHeight, Infinity, version, preamble.edgeMarkerColumns);
        const layout = { map, width: geometry.originalWidth, height: geometry.originalHeight };
        const scored = await scoreMapped(pixels, width, height, map, geometry.originalWidth, strength, fit);
        const found = (await tryLayout(scored.scores, signal, failure, layout)) || (await tryLayout(scored.bounded, signal, failure, layout));
        if (found && found.carrierVersion === version) return {
          ...found, origWidth: geometry.originalWidth, origHeight: geometry.originalHeight,
          matrix, readChannel: readOptions.channel, geometry: { ...geometry, matrix,
            ...(found.edgeMarkers === false ? { referenceMarkers: [], referenceCount: 0, expectedReferenceMarkers: [] } : {}),
            corners: [[0, 0], [geometry.originalWidth - 1, 0], [geometry.originalWidth - 1, geometry.originalHeight - 1], [0, geometry.originalHeight - 1]]
              .map(([x, y]) => mappedPoint(matrix, x, y)) }, visualTransform: geometry.model
        };
      }
      await yieldNow();
    }
    return { locatorOnly: true, carrierVersion: version, origWidth: geometry.originalWidth, origHeight: geometry.originalHeight,
      matrix: geometry.matrix, geometry, visualTransform: geometry.model, failure };
  }

  function canUseReaderWorker(options) {
    return typeof Worker !== "undefined" && codecScriptUrl &&
      ["http:", "https:"].includes(new URL(codecScriptUrl).protocol) && options.worker !== false;
  }

  function searchInWorker(pixels, width, height, options, operation = "geometry") {
    return new Promise((resolve, reject) => {
      const url = new URL("pixelstow-transform-worker.js?v=20261021-native-detail1", codecScriptUrl);
      const worker = new Worker(url);
      let finished = false;
      const abort = () => { if (finished) return; cleanup(); reject(new DOMException("Search cancelled.", "AbortError")); };
      const cleanup = () => {
        finished = true;
        worker.onmessage = worker.onerror = null;
        worker.terminate();
        options.signal?.removeEventListener("abort", abort);
      };
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.signature) { options.onSignature?.(data.signature); return; }
        if (data.progress) { options.onProgress?.(data.progress); return; }
        cleanup();
        if (data.error) reject(new Error(data.error)); else resolve(data.result);
      };
      worker.onerror = () => { cleanup(); reject(new Error("The visual reader could not start. Reload the local page and check that its worker scripts are available.")); };
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const copy = new Uint8Array(pixels);
        worker.postMessage({ pixels: copy, width, height, operation, mode: options.mode, forceSearch: options.forceSearch,
          includeLegacy: options.includeLegacy ?? legacyRecovery, carrierVersion: options.carrierVersion, nativeOnly: options.nativeOnly,
          corners: options.corners, seed: options.seed, deadline: options.deadline, scaleGuide: options.scaleGuide, calibration: options.calibration,
          reduction: options.reduction, maxMilliseconds: options.maxMilliseconds, minimumCoverage: options.minimumCoverage,
          seedDeadline: options.seedDeadline, camera: options.camera, scan: options.scan,
          searchState: options.searchState, stopOnHighConfidence: options.stopOnHighConfidence,
          resumeDiscovery: options.resumeDiscovery, calibratedOnly: options.calibratedOnly,
          earlyPayload: options.earlyPayload, refinementState: options.refinementState, contentSearch: options.contentSearch,
          strength: options.strength, visual: options.visual, diagnostic: options.diagnostic,
          toneProfile: options.toneProfile, restoreColour: options.restoreColour,
          tracks: options.tracks, edgeBand: options.edgeBand, ghostFrames: options.ghostFrames,
          discover: options.discover, search: options.search, mip: options.mip,
          mipConfirmed: options.mipConfirmed, mipLap: options.mipLap }, [copy.buffer]);
      } catch (error) { cleanup(); reject(error); }
    });
  }

  async function findVisualTransform(pixels, width, height, options = {}) {
    options = recoveryOptions(options);
    options.failure ||= { stage: "markers" };
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    if (!root.PixelStowTransform) throw new Error("The visual transform reader script is missing. Reload this page.");
    if (!options.geometryOnly) {
      const scan = await scanMarkers(pixels, width, height, options);
      const read = await readMarkerCandidates(pixels, width, height, scan, options);
      if (!read.unreadable || !scan.searchState?.pending.length) return read;
      // Strong markers permit an early read, never acceptance without the body
      // checksum. Resume unvisited scales if that promising fit cannot decode.
      options.onProgress?.("The strong marker fit did not decode. Comparing the remaining image scales…");
      const remaining = await scanMarkers(pixels, width, height, { ...options, searchState: scan.searchState, stopOnHighConfidence: false });
      const retried = await readMarkerCandidates(pixels, width, height, remaining, options);
      return retried.found && !retried.unreadable || (retried.markers?.length || 0) > (read.markers?.length || 0) ? retried : read;
    }
    // A page opened from disk has an opaque origin and cannot start this worker.
    // The same detector can run on the page, yielding between chunks for cancel/UI.
    const versions = recoveryVersions(options).filter((version) => locatorProfile(version));
    if (!versions.length) return { found: false, geometry: null, candidates: [], markers: [],
      reason: "The selected format has no photographic recovery markers." };
    const search = canUseReaderWorker(options)
      ? await searchInWorker(pixels, width, height, options)
      : await root.PixelStowTransform.find(pixels, width, height, options, versions.map((version) => visualAdapter(pixels, width, height, version)));
    return search;
  }

  async function reducePhoto(pixels, width, height, targetWidth, targetHeight, signal) {
    // Area averaging suppresses screen/sensor moire. Sampling a few bilinear
    // points when shrinking by 3x would alias the very texture being removed.
    // One row accumulator avoids a full-size floating-point intermediate raster.
    const rx = width / targetWidth, ry = height / targetHeight;
    const columns = Array.from({ length: targetWidth }, (_, x) => {
      const left = x * rx, right = (x + 1) * rx, first = Math.floor(left);
      const last = Math.min(width - 1, Math.ceil(right) - 1);
      return { first, weights: Float64Array.from({ length: last - first + 1 }, (_, i) =>
        Math.max(0, Math.min(right, first + i + 1) - Math.max(left, first + i)) / rx) };
    });
    const out = new Uint8Array(targetWidth * targetHeight * 4), row = new Float64Array(targetWidth * 4);
    for (let y = 0; y < targetHeight; y++) {
      if ((y & 7) === 0) {
        if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
        await yieldNow();
      }
      row.fill(0);
      const top = y * ry, bottom = (y + 1) * ry;
      for (let sy = Math.floor(top); sy < Math.min(height, Math.ceil(bottom)); sy++) {
        const wy = Math.max(0, Math.min(bottom, sy + 1) - Math.max(top, sy)) / ry;
        for (let x = 0; x < targetWidth; x++) {
          const { first, weights } = columns[x], dest = x * 4;
          for (let k = 0; k < weights.length; k++) {
            const src = (first + k + sy * width) * 4, weight = weights[k] * wy;
            row[dest] += pixels[src] * weight;
            row[dest + 1] += pixels[src + 1] * weight;
            row[dest + 2] += pixels[src + 2] * weight;
            row[dest + 3] += pixels[src + 3] * weight;
          }
        }
      }
      for (let i = 0; i < row.length; i++) out[y * row.length + i] = roundHalfToEven(row[i]);
    }
    return { pixels: out, width: targetWidth, height: targetHeight };
  }

  function liftPhotoResult(result, width, height, readWidth, readHeight) {
    const sx = width / readWidth, sy = height / readHeight, ox = (sx - 1) / 2, oy = (sy - 1) / 2;
    const lift = (h) => [sx * h[0] + ox * h[6], sx * h[1] + ox * h[7], sx * h[2] + ox * h[8],
      sy * h[3] + oy * h[6], sy * h[4] + oy * h[7], sy * h[5] + oy * h[8], h[6], h[7], h[8]];
    const liftGeometry = (geometry) => ({ ...geometry, matrix: lift(geometry.matrix),
      corners: geometry.corners.map((p) => ({ x: sx * p.x + ox, y: sy * p.y + oy })),
      expectedMarkers: geometry.expectedMarkers.map((m) => ({ ...m, matrix: lift(m.matrix) })),
      referenceMarkers: geometry.referenceMarkers?.map((m) => ({ ...m, matrix: lift(m.matrix), expectedMatrix: lift(m.expectedMatrix) })) });
    const geometry = result.geometry && liftGeometry(result.geometry);
    return { ...result, geometry, markers: result.markers?.map((m) => ({ ...m, matrix: lift(m.matrix),
      initialMatrix: m.initialMatrix && lift(m.initialMatrix) })),
      candidates: result.candidates?.map(liftGeometry),
      localizationResolution: { width: readWidth, height: readHeight } };
  }

  function geometryAt(geometry, matrix) {
    const { originalWidth: w, originalHeight: h } = geometry;
    return { ...geometry, matrix,
      corners: [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]].map(([x, y]) => mappedPoint(matrix, x, y)),
      expectedMarkers: locatorLayout(w, h, geometry.carrierVersion || CARRIER_V6).map((p) => ({ id: p.id, matrix: [
        matrix[0], matrix[1], matrix[2] + matrix[0] * p.x + matrix[1] * p.y,
        matrix[3], matrix[4], matrix[5] + matrix[3] * p.x + matrix[4] * p.y,
        matrix[6], matrix[7], matrix[8] + matrix[6] * p.x + matrix[7] * p.y] })) };
  }

  function photoPhaseAt(field, x, y) {
    if (field.kind === "spline") return root.PixelStowLattice.at(field, x, y);
    const gx = Math.max(0, Math.min(field.columns - 1, (x - field.step / 2) / field.step));
    const gy = Math.max(0, Math.min(field.rows - 1, (y - field.step / 2) / field.step));
    const ix = Math.floor(gx), iy = Math.floor(gy), jx = Math.min(field.columns - 1, ix + 1), jy = Math.min(field.rows - 1, iy + 1);
    const fx = gx - ix, fy = gy - iy, values = field.offsets;
    const a = (ix + iy * field.columns) * 2, b = (jx + iy * field.columns) * 2;
    const c = (ix + jy * field.columns) * 2, d = (jx + jy * field.columns) * 2;
    return { x: (values[a] * (1 - fx) + values[b] * fx) * (1 - fy) + (values[c] * (1 - fx) + values[d] * fx) * fy,
      y: (values[a + 1] * (1 - fx) + values[b + 1] * fx) * (1 - fy) + (values[c + 1] * (1 - fx) + values[d + 1] * fx) * fy };
  }

  async function measurePhotoPhase(image, signal) {
    // Both symbols share a central 2x2 lobe on the four-pixel lattice. Its
    // horizontal/vertical Fourier phase locates pixels without knowing the bits.
    // Markers establish the plane; this only corrects small remaining grid errors.
    const { pixels, width, height } = image, step = 32, radius = 32;
    if (width < radius * 4 || height < radius * 4) return null;
    const columns = Math.ceil(width / step), rows = Math.ceil(height / step);
    const offsets = new Float32Array(columns * rows * 2), luma = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      if ((y & 31) === 0) { checkCancelled(signal); await yieldNow(); }
      for (let x = 0; x < width; x++) {
        const i = x + y * width;
        luma[i] = (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;
      }
    }
    const cosine = [1, 0, -1, 0], sine = [0, -1, 0, 1];
    const weights = Float64Array.from({ length: radius * 2 }, (_, i) => 0.5 + 0.5 * Math.cos((i - radius) * Math.PI / radius));
    const phase = (real, imaginary) => {
      let angle = -3 * Math.PI / 4 - Math.atan2(imaginary, real);
      if (angle > Math.PI) angle -= 2 * Math.PI;
      if (angle < -Math.PI) angle += 2 * Math.PI;
      return angle * 2 / Math.PI;
    };
    let strong = 0;
    for (let gy = 0; gy < rows; gy++) {
      checkCancelled(signal); await yieldNow();
      for (let gx = 0; gx < columns; gx++) {
        const cx = step / 2 + gx * step, cy = step / 2 + gy * step;
        let xr = 0, xi = 0, yr = 0, yi = 0;
        for (let y = Math.max(1, cy - radius); y < Math.min(height - 1, cy + radius); y++) {
          const wy = weights[y - cy + radius];
          for (let x = Math.max(1, cx - radius); x < Math.min(width - 1, cx + radius); x++) {
            const weight = weights[x - cx + radius] * wy, i = x + y * width;
            // Second differences remove slowly varying photo content before
            // measuring the carrier, including at partially covered edge windows.
            const vx = (2 * luma[i] - luma[i - 1] - luma[i + 1]) * weight;
            const vy = (2 * luma[i] - luma[i - width] - luma[i + width]) * weight;
            xr += vx * cosine[x & 3]; xi += vx * sine[x & 3];
            yr += vy * cosine[y & 3]; yi += vy * sine[y & 3];
          }
        }
        if (Math.min(Math.hypot(xr, xi), Math.hypot(yr, yi)) > 512) strong++;
        let ox = phase(xr, xi), oy = phase(yr, yi);
        const index = (gx + gy * columns) * 2;
        let ax = 0, ay = 0, neighbours = 0;
        if (gx) { ax += offsets[index - 2]; ay += offsets[index - 1]; neighbours++; }
        if (gy) { ax += offsets[index - columns * 2]; ay += offsets[index - columns * 2 + 1]; neighbours++; }
        // Fourier phase wraps every four pixels. Continue from neighbouring
        // windows rather than allowing a discontinuous four-pixel jump.
        if (neighbours) {
          ox += Math.round((ax / neighbours - ox) / BLOCK) * BLOCK;
          oy += Math.round((ay / neighbours - oy) / BLOCK) * BLOCK;
        }
        if (!Number.isFinite(ox + oy) || Math.max(Math.abs(ox), Math.abs(oy)) > 8) return null;
        offsets[index] = ox; offsets[index + 1] = oy;
      }
    }
    return strong >= columns * rows * 0.7 ? { columns, rows, step, offsets } : null;
  }

  function composePhotoPhase(previous, residual) {
    if (!previous) return residual;
    for (let y = 0; y < residual.rows; y++) for (let x = 0; x < residual.columns; x++) {
      const i = (x + y * residual.columns) * 2, rx = residual.offsets[i], ry = residual.offsets[i + 1];
      const prior = photoPhaseAt(previous, (x + 0.5) * residual.step + rx, (y + 0.5) * residual.step + ry);
      if (Math.max(Math.abs(rx + prior.x), Math.abs(ry + prior.y)) > 8) return null;
      residual.offsets[i] = rx + prior.x; residual.offsets[i + 1] = ry + prior.y;
    }
    return residual;
  }

  async function rectifyPhoto(pixels, width, height, nativeWidth, nativeHeight, matrix, signal, phaseCorrection) {
    // Each output pixel is on the original carrier lattice. A single homography
    // maps its footprint into the full capture; no triangles or preview resize.
    const out = new Uint8Array(nativeWidth * nativeHeight * 4), sum = new Float64Array(4);
    const curved = phaseCorrection?.kind === "spline", local = new Float64Array(12);
    for (let y = 0; y < nativeHeight; y++) {
      if ((y & 7) === 0) {
        if (signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
        await yieldNow();
      }
      for (let x = 0; x < nativeWidth; x++) {
        const d = matrix[6] * x + matrix[7] * y + matrix[8];
        const cx = (matrix[0] * x + matrix[1] * y + matrix[2]) / d;
        const cy = (matrix[3] * x + matrix[4] * y + matrix[5]) / d;
        // Local derivatives determine quadrature density, not the mapping itself.
        // Subsamples still use the exact projective denominator at their position.
        let nx = Math.min(8, Math.max(1, Math.ceil(Math.hypot(matrix[0] - cx * matrix[6], matrix[3] - cy * matrix[6]) / Math.abs(d))));
        let ny = Math.min(8, Math.max(1, Math.ceil(Math.hypot(matrix[1] - cx * matrix[7], matrix[4] - cy * matrix[7]) / Math.abs(d))));
        let correction;
        if (curved) {
          root.PixelStowLattice.evaluate(phaseCorrection, x, y, local);
          correction = { x: local[0], y: local[1] };
          const qx = x + local[0], qy = y + local[1], divisor = matrix[6] * qx + matrix[7] * qy + matrix[8];
          const sx = (matrix[0] * qx + matrix[1] * qy + matrix[2]) / divisor;
          const sy = (matrix[3] * qx + matrix[4] * qy + matrix[5]) / divisor;
          const ax = (matrix[0] - sx * matrix[6]) / divisor, ay = (matrix[3] - sy * matrix[6]) / divisor;
          const bx = (matrix[1] - sx * matrix[7]) / divisor, by = (matrix[4] - sy * matrix[7]) / divisor;
          nx = Math.min(8, Math.max(1, Math.ceil(Math.hypot(ax * (1 + local[2]) + bx * local[4], ay * (1 + local[2]) + by * local[4]))));
          ny = Math.min(8, Math.max(1, Math.ceil(Math.hypot(ax * local[3] + bx * (1 + local[5]), ay * local[3] + by * (1 + local[5])))));
        } else correction = phaseCorrection ? photoPhaseAt(phaseCorrection, x, y) : { x: 0, y: 0 };
        sum.fill(0);
        for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
          const u = (ix + 0.5) / nx - 0.5, v = (iy + 0.5) / ny - 0.5;
          // A local quadratic expansion of the spline follows the curved pixel
          // footprint, including its Jacobian, without re-evaluating 16 controls
          // for every subpixel. The projective denominator remains continuous.
          const ox = curved ? local[0] + local[2] * u + local[3] * v + (local[6] * u * u + 2 * local[7] * u * v + local[8] * v * v) / 2 : correction.x;
          const oy = curved ? local[1] + local[4] * u + local[5] * v + (local[9] * u * u + 2 * local[10] * u * v + local[11] * v * v) / 2 : correction.y;
          const px = x + ox + u, py = y + oy + v;
          const divisor = matrix[6] * px + matrix[7] * py + matrix[8];
          const sx = Math.max(0, Math.min(width - 1, (matrix[0] * px + matrix[1] * py + matrix[2]) / divisor));
          const sy = Math.max(0, Math.min(height - 1, (matrix[3] * px + matrix[4] * py + matrix[5]) / divisor));
          const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
          const a = (x0 + y0 * width) * 4, b = (Math.min(width - 1, x0 + 1) + y0 * width) * 4;
          const c = (x0 + Math.min(height - 1, y0 + 1) * width) * 4, e = (Math.min(width - 1, x0 + 1) + Math.min(height - 1, y0 + 1) * width) * 4;
          for (let channel = 0; channel < 4; channel++) {
            sum[channel] += (pixels[a + channel] * (1 - fx) + pixels[b + channel] * fx) * (1 - fy) +
              (pixels[c + channel] * (1 - fx) + pixels[e + channel] * fx) * fy;
          }
        }
        const dest = (x + y * nativeWidth) * 4;
        for (let channel = 0; channel < 4; channel++) out[dest + channel] = clampChannel(sum[channel] / (nx * ny));
      }
    }
    return { pixels: out, width: nativeWidth, height: nativeHeight };
  }

  function photoReadResult(recovered, image, photoGeometry) {
    // The small phase refinement is now in native read space. Compose it on the
    // right of the photo transform, rather than shifting camera pixels linearly.
    const h = photoGeometry.matrix, q = recovered.matrix, matrix = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) matrix[r * 3 + c] += h[r * 3 + k] * q[k * 3 + c];
    }
    return { ...recovered, matrix, geometry: { ...geometryAt(photoGeometry, matrix),
        ...(recovered.edgeMarkers === false ? { referenceMarkers: [], referenceCount: 0, expectedReferenceMarkers: [] } : {}) },
      readResolution: { width: image.width, height: image.height, geometry: recovered.geometry, photoMatrix: h,
        phaseCorrection: image.phaseCorrection, channel: recovered.readChannel },
      readImage: { ...image, matrix: q } };
  }

  function photoMarkerAnchors(geometry, markers) {
    const inverse = root.PixelStowTransform.invert(geometry.matrix);
    const profile = locatorProfile(geometry.carrierVersion || CARRIER_V6);
    const layout = locatorLayout(geometry.originalWidth, geometry.originalHeight, profile.version);
    const maximum = Math.min(48, Math.max(geometry.originalWidth, geometry.originalHeight) * 0.04);
    return (markers || []).filter((m) => m.matrix && (m.verification === "header" ||
      m.verification === "pattern" && m.localized) && m.quality >= 0.6)
      .flatMap((m) => {
        const patch = layout.find((p) => p.id === m.id);
        if (!patch) return [];
        const cx = (profile.width - 1) / 2, cy = (profile.height - 1) / 2;
        const controls = [[cx, cy, 1]];
        // Independently refined axes give curvature information between marker
        // centres. A prediction-only pattern match supplies no measured slope.
        if (m.localized && m.quality >= 0.85) controls.push([cx * 0.35, cy, 0.25], [cx * 1.65, cy, 0.25],
          [cx, cy * 0.35, 0.25], [cx, cy * 1.65, 0.25]);
        return controls.flatMap(([u, v, weight]) => {
          const x = patch.x + u, y = patch.y + v, observed = mappedPoint(m.matrix, u, v);
          const predicted = mappedPoint(inverse, observed.x, observed.y);
          const dx = predicted.x - x, dy = predicted.y - y;
          return Number.isFinite(dx + dy) && Math.max(Math.abs(dx), Math.abs(dy)) <= maximum
            ? [{ x, y, dx, dy, markerId: m.id, control: weight < 1,
              weight: weight * m.quality ** 2 * (m.verification === "header" ? 1 : 0.75) }] : [];
        });
      });
  }

  async function readTrackedPhoto(pixels, width, height, geometry, signal, onProgress, markers, options, nativeGeometry, fast) {
    const anchors = photoMarkerAnchors(geometry, markers);
    if (!root.PixelStowLattice || new Set(anchors.map((a) => a.markerId)).size < 3) return null;
    const deadline = Math.min(options.deadline || Infinity, Date.now() + 8000);
    let previous;
    for (let pass = 0; pass < 2 && Date.now() < deadline; pass++) {
      const field = await root.PixelStowLattice.track(pixels, width, height, geometry, {
        signal, onProgress, deadline, anchors, previous, channel: pass ? 1 : undefined,
        reservations: reservedLocators(geometry.originalWidth, geometry.originalHeight, geometry.carrierVersion || CARRIER_V6)
      });
      if (!field) continue;
      onProgress?.("Sampling the original capture through the curved wavelet grid…");
      const corrected = await rectifyPhoto(pixels, width, height, geometry.originalWidth, geometry.originalHeight, geometry.matrix, signal, field);
      for (const channel of [undefined, 1, 0, 2]) {
        const retried = await readVisualMapping(corrected.pixels, corrected.width, corrected.height, nativeGeometry, signal, { ...fast, channel });
        if (!retried.locatorOnly) return photoReadResult(retried, { ...corrected, phaseCorrection: field }, geometry);
      }
      // Fourier phase is an estimate. Check small fractional shifts cheaply at
      // the repeated preamble before undertaking any full payload read.
      onProgress?.("Checking subpixel alignment of the tracked grid…");
      for (const channel of [undefined, 1]) {
        const retried = await readVisualMapping(corrected.pixels, corrected.width, corrected.height, nativeGeometry, signal,
          { ...fast, channel, offsets: [0, -0.25, 0.25] });
        if (!retried.locatorOnly) return photoReadResult(retried, { ...corrected, phaseCorrection: field }, geometry);
      }
      previous = field;
    }
    return null;
  }

  async function readPhotoMapping(pixels, width, height, geometry, signal, onProgress, markers, options = {}) {
    let image = await rectifyPhoto(pixels, width, height, geometry.originalWidth, geometry.originalHeight, geometry.matrix, signal);
    const nativeGeometry = geometryAt(geometry, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // A correct native grid needs one template. Avoid repeatedly decoding a
    // whole damaged compressed payload at every strength and nearby phase.
    const fast = { offsets: [0], strengths: [16], failure: options.failure || { stage: "wavelets" } };
    let recovered = await readVisualMapping(image.pixels, image.width, image.height, nativeGeometry, signal, fast);
    if (options.earlyPayloadProbe) return photoReadResult(recovered, image, geometry);
    if (recovered.locatorOnly) {
      let working = image, previous, tracked = false;
      // Residual phase can be measured again after the first correction. Every
      // reconstruction still samples the full original; no resampling cascade.
      for (let pass = 0; pass < 3; pass++) {
        onProgress?.("Refining the photographed pixel grid from its carrier pattern (" + (pass + 1) + "/3)…");
        const measured = await measurePhotoPhase(working, signal);
        const phaseCorrection = measured && composePhotoPhase(previous, measured);
        if (!phaseCorrection) {
          if (!previous) recovered = await readVisualMapping(image.pixels, image.width, image.height, nativeGeometry, signal, { failure: fast.failure });
          break;
        }
        const corrected = await rectifyPhoto(pixels, width, height, image.width, image.height, geometry.matrix, signal, phaseCorrection);
        // Screen/camera colour channels can have different interference. Keep
        // the colour raster intact and verify each alternate through the same CRC.
        for (const channel of [undefined, 1, 0, 2]) {
          const retried = await readVisualMapping(corrected.pixels, corrected.width, corrected.height, nativeGeometry, signal, { ...fast, channel });
          if (!retried.locatorOnly) {
            image = { ...corrected, phaseCorrection }; recovered = retried;
            return photoReadResult(recovered, image, geometry);
          }
        }
        // Try original-pixel tracking after the first inexpensive phase attempt.
        // Retain the remaining proven phase passes if a curved fit cannot verify.
        if (pass === 0) {
          tracked = true;
          const followed = await readTrackedPhoto(pixels, width, height, geometry, signal, onProgress, markers, options, nativeGeometry, fast);
          if (followed) return followed;
        }
        previous = phaseCorrection; working = corrected;
      }
      // If native reconstruction destroyed the usable phase, measure smaller,
      // oversampled windows directly in the original capture. Keep the proven
      // reader above and its successful fast path; no writer/format change.
      if (recovered.locatorOnly && !tracked) {
        const followed = await readTrackedPhoto(pixels, width, height, geometry, signal, onProgress, markers, options, nativeGeometry, fast);
        if (followed) return followed;
      }
    }
    return photoReadResult(recovered, image, geometry);
  }

  function retainVisualResult(pixels, width, height, result, workingImage) {
    if (!result) return;
    if (result.geometry) visualMappings.set(pixels, { width, height, geometry: result.geometry,
      readResolution: result.readResolution, carrierVersion: result.carrierVersion || result.markers?.[0]?.carrierVersion, workingImage,
      scaleGuide: result.scaleGuide, calibration: result.calibration, diagnostics: result });
    else if (result.unreadable) visualMappings.set(pixels, { width, height, unreadable: true,
      carrierVersion: result.carrierVersion || result.markers?.[0]?.carrierVersion, scaleGuide: result.scaleGuide, calibration: result.calibration, diagnostics: result });
  }

  function calibrationTrace(hint, trace, method) {
    const detected = Boolean(hint?.detected);
    return { status: detected ? "detected" : trace?.status || "not-checked", attempted: false, used: false,
      ...trace, ...(detected ? { status: "detected" } : {}), ...(method ? { method } : {}) };
  }

  function validScaleGuide(hint, width, height) {
    return hint?.detected && hint.width === width && hint.height === height && Number.isFinite(hint.scale) &&
      hint.scale >= .25 && hint.scale <= 8 && Number.isFinite(hint.fx) && Number.isFinite(hint.fy) && Math.hypot(hint.fx, hint.fy) > 0 ? hint : null;
  }

  function rankMarkerCandidates(candidates) {
    const sorted = candidates.slice().sort((a, b) => (b.geometry.rank || 0) - (a.geometry.rank || 0));
    const distinct = [];
    for (const candidate of sorted) {
      const g = candidate.geometry;
      if (distinct.some(({ geometry: other }) => other.originalWidth === g.originalWidth && other.originalHeight === g.originalHeight &&
        other.corners.every((p, i) => Math.hypot(p.x - g.corners[i].x, p.y - g.corners[i].y) < 0.5))) continue;
      distinct.push(candidate);
      if (distinct.length === 8) break;
    }
    return distinct;
  }

  function markerBasis(matrix, version = CARRIER_V6) {
    const p = locatorProfile(version);
    const centre = mappedPoint(matrix, p.width / 2, p.height / 2);
    const x = mappedPoint(matrix, p.width / 2 + 1, p.height / 2);
    const y = mappedPoint(matrix, p.width / 2, p.height / 2 + 1);
    return Math.min(Math.hypot(x.x - centre.x, x.y - centre.y), Math.hypot(y.x - centre.x, y.y - centre.y));
  }

  function nextMarkerScale(pending, samples, start, sizes, seed) {
    if (!samples.length) return pending.reduce((best, i) => Math.abs(i - start) < Math.abs(best - start) ? i : best, pending[0]);
    const best = samples.slice().sort((a, b) => b.score - a.score)[0];
    // Measured neighbours supply a warmer/colder slope. Weak pilot correlations
    // guide scheduling only: they never verify encoding or eliminate a branch.
    const priority = (index) => {
      const direction = Math.sign(index - best.index);
      const neighbour = samples.filter((s) => Math.sign(s.index - best.index) === direction)
        .sort((a, b) => Math.abs(a.index - best.index) - Math.abs(b.index - best.index))[0];
      const colder = neighbour && neighbour.score < best.score ? 2 : 0;
      const targetDivisor = seed ? markerBasis(seed.matrix, seed.carrierVersion) / 1.2 : sizes[best.index].divisor;
      const spacing = seed ? Math.abs(Math.log2(sizes[index].divisor / targetDivisor)) : Math.abs(index - best.index);
      return spacing + colder + (index < best.index ? 0.05 : 0);
    };
    return pending.reduce((bestIndex, index) => priority(index) < priority(bestIndex) ? index : bestIndex, pending[0]);
  }

  // Cheap calibration only. No markers, carrier header or payload are read.
  async function scanScaleGuide(pixels, width, height, options = {}) {
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    if (canUseReaderWorker(options)) return searchInWorker(pixels, width, height, options, "scale-guide");
    if (!root.PixelStowSpectrum?.scaleGuide) return null;
    return root.PixelStowSpectrum.scaleGuide(pixels, width, height, SCALE_PILOT, options);
  }

  async function scanEdgeGuide(pixels, width, height, options = {}) {
    // File imports can wait for the same work on slower devices. Live capture
    // supplies its own short budget so stale frames can still be replaced.
    options = { maxMilliseconds: 6000, ...options };
    assertImage(pixels, width, height); checkCancelled(options.signal);
    if (!recoveryVersions(options).some(compactCarrier)) return null;
    if (canUseReaderWorker(options)) return searchInWorker(pixels, width, height, options, "edge-guide");
    if (!root.PixelStowEdgeGuide?.detect) return null;
    const hint = await root.PixelStowEdgeGuide.detect(pixels, width, height, options);
    return hint && (hint.detected || options.diagnostic && hint.diagnostic)
      ? { ...hint, kind: "edge", confirmed: false, width, height } : null;
  }

  // Pure discovery: only locator symbols are read. No carrier preamble, body,
  // decompression or payload verification is performed by this operation.
  async function trackMarkers(pixels, width, height, options = {}) {
    options = recoveryOptions(options);
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    const band = options.edgeBand ?? 0.2;
    if (canUseReaderWorker(options)) return searchInWorker(pixels, width, height, { ...options, edgeBand: band, worker: false }, "track");
    if (!root.PixelStowTransform?.track) throw new Error("The marker tracker is missing. Reload this page.");
    const versions = recoveryVersions(options).filter((version) => locatorProfile(version));
    const carried = (options.tracks || []).filter((marker) => marker?.matrix && Number.isFinite(marker.id));
    const lockedIds = (markers) => new Set((markers || []).filter((marker) => marker && !marker.ghost && Number.isFinite(marker.id)).map((marker) => marker.id));
    async function probe(nominal, slice) {
      checkCancelled(options.signal);
      if (Date.now() >= (options.deadline || Infinity)) return null;
      const pad = 64 * nominal;
      const left = Math.max(0, Math.floor(slice.region.x0 - pad));
      const top = Math.max(0, Math.floor(slice.region.y0 - pad));
      const right = Math.min(width, Math.ceil(slice.region.x1 + pad));
      const bottom = Math.min(height, Math.ceil(slice.region.y1 + pad));
      const cw = Math.max(1, right - left), ch = Math.max(1, bottom - top);
      const rw = Math.max(1, Math.round(cw / nominal)), rh = Math.max(1, Math.round(ch / nominal));
      if (nominal > 1 && (rw < 48 || rh < 48)) return null;
      const cropped = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) cropped.set(pixels.subarray(((top + y) * width + left) * 4, ((top + y) * width + left) * 4 + cw * 4), y * cw * 4);
      const image = rw === cw && rh === ch ? { pixels: cropped, width: cw, height: ch }
        : await reducePhoto(cropped, cw, ch, rw, rh, options.signal);
      const sx = image.width / cw, sy = image.height / ch;
      const region = {
        x0: Math.max(0, (slice.region.x0 - left) * sx), y0: Math.max(0, (slice.region.y0 - top) * sy),
        x1: Math.min(image.width, (slice.region.x1 - left) * sx), y1: Math.min(image.height, (slice.region.y1 - top) * sy)
      };
      const levelDeadline = Math.min(options.deadline || Infinity, Date.now() + 1500);
      const found = await findVisualTransform(image.pixels, image.width, image.height, {
        signal: options.signal, deadline: levelDeadline, maxMilliseconds: 1500, forceSearch: true,
        worker: false, geometryOnly: true, singleResolution: true, scaleGuide: false, seedOnly: true,
        frequencyOnly: true, mode: "perspective", region, camera: true
      });
      const seed = found.markers?.[0];
      if (!seed?.matrix) return null;
      const lift = (matrix) => {
        const px = cw / image.width, py = ch / image.height, ox = (px - 1) / 2, oy = (py - 1) / 2;
        const h = [px * matrix[0] + ox * matrix[6], px * matrix[1] + ox * matrix[7], px * matrix[2] + ox * matrix[8],
          py * matrix[3] + oy * matrix[6], py * matrix[4] + oy * matrix[7], py * matrix[5] + oy * matrix[8],
          matrix[6], matrix[7], matrix[8]];
        return [h[0] + left * h[6], h[1] + left * h[7], h[2] + left * h[8],
          h[3] + top * h[6], h[4] + top * h[7], h[5] + top * h[8], h[6], h[7], h[8]];
      };
      const lifted = { ...seed, mip: nominal, matrix: lift(seed.matrix), initialMatrix: seed.initialMatrix && lift(seed.initialMatrix) };
      const full = visualAdapter(pixels, width, height, seed.carrierVersion || versions[0]);
      const confirmed = await root.PixelStowTransform.track(pixels, width, height, {
        ...options, edgeBand: band, tracks: [lifted], discover: false, worker: false,
        deadline: Math.min(options.deadline || Infinity, Date.now() + 400), maxMilliseconds: 400
      }, [full]);
      for (const marker of [...(confirmed.tracks || []), ...(confirmed.markers || [])]) marker.mip = nominal;
      if (confirmed.markers?.length || confirmed.tracks?.length) return { ...confirmed, mip: nominal };
      return { tracks: [lifted], markers: [lifted], squares: [], ghosts: [], ready: false, mip: nominal, edgeBand: band,
        signature: { confirmed: true, likely: true, message: "Corner found at " + (nominal === 1 ? "full size" : "1/" + nominal + " size") + ". Following it." } };
    }
    async function probeFrame(nominal) {
      checkCancelled(options.signal);
      if (Date.now() >= (options.deadline || Infinity)) return null;
      const rw = Math.max(1, Math.round(width / nominal)), rh = Math.max(1, Math.round(height / nominal));
      if (nominal > 1 && (rw < 48 || rh < 48)) return null;
      const image = nominal === 1 ? { pixels, width, height } : await reducePhoto(pixels, width, height, rw, rh, options.signal);
      const levelDeadline = Math.min(options.deadline || Infinity, Date.now() + 1500);
      const found = await findVisualTransform(image.pixels, image.width, image.height, {
        signal: options.signal, deadline: levelDeadline, maxMilliseconds: 1500, forceSearch: true,
        worker: false, geometryOnly: true, singleResolution: true, scaleGuide: false, seedOnly: true,
        frequencyOnly: true, mode: "perspective", edgeBand: band, camera: true
      });
      const seed = found.markers?.[0];
      if (!seed?.matrix) return null;
      const lift = (matrix) => {
        const px = width / image.width, py = height / image.height, ox = (px - 1) / 2, oy = (py - 1) / 2;
        return [px * matrix[0] + ox * matrix[6], px * matrix[1] + ox * matrix[7], px * matrix[2] + ox * matrix[8],
          py * matrix[3] + oy * matrix[6], py * matrix[4] + oy * matrix[7], py * matrix[5] + oy * matrix[8],
          matrix[6], matrix[7], matrix[8]];
      };
      const lifted = { ...seed, mip: nominal, matrix: lift(seed.matrix), initialMatrix: seed.initialMatrix && lift(seed.initialMatrix) };
      const full = visualAdapter(pixels, width, height, seed.carrierVersion || versions[0]);
      const confirmed = await root.PixelStowTransform.track(pixels, width, height, {
        ...options, edgeBand: band, tracks: [lifted], discover: false, worker: false,
        deadline: Math.min(options.deadline || Infinity, Date.now() + 400), maxMilliseconds: 400
      }, [full]);
      for (const marker of [...(confirmed.tracks || []), ...(confirmed.markers || [])]) marker.mip = nominal;
      if (confirmed.markers?.length || confirmed.tracks?.length) return { ...confirmed, mip: nominal };
      return { tracks: [lifted], markers: [lifted], squares: [], ghosts: [], ready: false, mip: nominal, edgeBand: band,
        signature: { confirmed: true, likely: true, message: "Corner found at " + (nominal === 1 ? "full size" : "1/" + nominal + " size") + ". Following it." } };
    }
    // A held marker is followed on this frame. One unconfirmed marker keeps its
    // mip for a single lap of the border. A second marker confirms that mip.
    if (carried.length) {
      const adapters = versions.map((version) => visualAdapter(pixels, width, height, version));
      const followBudget = Math.min(1800, Math.max(900, options.maxMilliseconds || 900));
      const deadline = Math.min(options.deadline || Infinity, Date.now() + followBudget);
      const followed = await root.PixelStowTransform.track(pixels, width, height, {
        ...options, edgeBand: band, tracks: carried, discover: false, worker: false, deadline, maxMilliseconds: followBudget
      }, adapters);
      if (options.mipConfirmed || !(options.mip >= 1) || lockedIds(followed.markers).size >= 2)
        return { ...followed, mip: options.mip >= 1 ? options.mip : followed.mip, mipConfirmed: options.mipConfirmed || lockedIds(followed.markers).size >= 2 };
      const index = options.search?.index || 0;
      const slice = root.PixelStowTransform.borderSlice(index, width, height, band);
      const found = await probe(options.mip, slice);
      const extra = (found?.markers || found?.tracks || []).filter((marker) => marker && !marker.ghost);
      const merged = new Map(followed.tracks.map((marker) => [marker.id, marker]));
      for (const marker of extra) merged.set(marker.id, marker);
      const tracks = [...merged.values()];
      const markers = tracks.filter((marker) => !marker.ghost);
      const lap = (options.mipLap || 0) + 1;
      const confirmed = lockedIds(markers).size >= 2;
      if (!confirmed && lap >= 8) return { tracks: [], markers: [], squares: [], ghosts: [], ready: false, mipDrop: true,
        search: { index: index + 1 }, edgeBand: band,
        signature: { confirmed: false, likely: false, message: "No second corner at " + (options.mip === 1 ? "full size" : "1/" + options.mip + " size") + ". Checking the other sizes." } };
      const squares = [...(followed.squares || []), ...((found?.squares || []).filter((square) => !followed.squares?.some((held) => held.id === square.id)))];
      return { ...followed, tracks, markers, squares, ready: confirmed ? followed.ready : false, mip: options.mip,
        mipConfirmed: confirmed, mipLap: lap, search: confirmed ? null : { index: index + 1 },
        signature: confirmed ? followed.signature : { confirmed: true, likely: true, message: "Checking the " + slice.name + " at " + (options.mip === 1 ? "full size" : "1/" + options.mip + " size") + " for another corner." } };
    }
    // A proposed mip with no held marker still walks one border piece at a time.
    // The first search does not: every coarse size covers the whole outer band.
    const knownMip = options.mip >= 1 && !options.mipDrop ? options.mip : 0;
    if (knownMip && !options.mipConfirmed) {
      const index = options.search?.index || 0;
      const slice = root.PixelStowTransform.borderSlice(index, width, height, band);
      const next = { index: index + 1 };
      const pass = "Looking at the " + slice.name + " at " + (knownMip === 1 ? "full size" : "1/" + knownMip + " size") + ".";
      const found = await probe(knownMip, slice);
      if (found) {
        const confirmed = lockedIds(found.markers).size >= 2;
        return { ...found, search: confirmed ? null : next, mipConfirmed: confirmed, mipLap: 0 };
      }
      const lap = (options.mipLap || 0) + 1;
      if (lap >= 8) return { tracks: [], markers: [], squares: [], ghosts: [], ready: false, mipDrop: true, search: next, edgeBand: band,
        signature: { confirmed: false, likely: false, message: "No second corner at " + (knownMip === 1 ? "full size" : "1/" + knownMip + " size") + ". Checking the other sizes." } };
      return { tracks: [], markers: [], squares: [], ghosts: [], ready: false, search: next, mip: knownMip, mipLap: lap, edgeBand: band,
        signature: { confirmed: false, likely: false, message: pass } };
    }
    const divisors = [16, 8, 4, 2, 1];
    for (const nominal of divisors) {
      options.onProgress?.("Searching the whole border at " + (nominal === 1 ? "full size" : "1/" + nominal + " size") + ".");
      const found = await probeFrame(nominal);
      if (!found) continue;
      const confirmed = lockedIds(found.markers).size >= 2;
      return { ...found, search: confirmed ? null : { index: 0 }, mipConfirmed: confirmed, mipLap: 0 };
    }
    return { tracks: [], markers: [], squares: [], ghosts: [], ready: false, search: null, edgeBand: band,
      signature: { confirmed: false, likely: false, message: "Looking around the whole border, from 1/16 size upward." } };
  }

  async function scanMarkers(pixels, width, height, options = {}) {
    options = recoveryOptions(options);
    options = { mode: "perspective", ...options };
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    if (canUseReaderWorker(options)) return searchInWorker(pixels, width, height, options, "markers");
    let scaleGuide = validScaleGuide(options.searchState?.scaleGuide || options.scaleGuide, width, height);
    let calibration = calibrationTrace(scaleGuide, options.searchState?.calibration || options.calibration);
    const native = options.calibratedOnly ? null : await findLocator(pixels, width, height, true, false, options.signal, options);
    if (native) {
      const patch = locatorLayout(width, height, native.carrierVersion).find((p) => p.id === native.id);
      const seed = readVisualLocator(pixels, width, height, [1, 0, patch.x, 0, 1, patch.y, 0, 0, 1], native.id, native.carrierVersion);
      const result = await findVisualTransform(pixels, width, height, { ...options, mode: "padding", seed,
        worker: false, geometryOnly: true });
      calibration = { ...calibration, used: false, method: "native" };
      const candidates = rankMarkerCandidates((result.candidates || []).map((geometry) => ({ geometry, markers: result.markers,
        markerSearch: result.markerSearch, refinementState: result.refinementState, scaleGuide, calibration })));
      return { ...result, scaleGuide, calibration, candidates, geometry: candidates[0]?.geometry, highConfidence: Boolean(candidates[0]?.geometry.highConfidence), width, height };
    }
    if (options.nativeOnly) return { found: false, geometry: null, candidates: [], markers: [], width, height,
      scaleGuide, calibration, reason: "No recovery marker headers were found on the native pixel grid." };
    if (!scaleGuide && options.scaleGuide !== false && options.scaleGuide !== true && !options.searchState && !options.seed &&
      !options.singleResolution && options.mode !== "padding" && recoveryVersions(options).some(compactCarrier)) {
      try { scaleGuide = await scanEdgeGuide(pixels, width, height, { worker: false, signal: options.signal, deadline: options.deadline });
        calibration = calibrationTrace(scaleGuide, { ...calibration, status: root.PixelStowEdgeGuide?.detect ? "not-detected" : "not-checked" }); }
      catch (error) { if (error?.name === "AbortError") throw error; }
    }
    if (!scaleGuide && !options.searchState && !options.seed && !options.singleResolution && options.mode !== "padding" &&
      options.scaleGuide === true && recoveryVersions(options).includes(CARRIER_V5)) {
      try { scaleGuide = await scanScaleGuide(pixels, width, height, { worker: false, signal: options.signal, deadline: options.deadline });
        calibration = calibrationTrace(scaleGuide, { ...calibration, status: root.PixelStowSpectrum?.scaleGuide ? "not-detected" : "not-checked" }); }
      catch (error) { if (error?.name === "AbortError") throw error; } // An optional guide must not break ordinary recovery.
    }
    if (options.calibratedOnly && !scaleGuide) return { found: false, geometry: null, candidates: [], markers: [], width, height,
      scaleGuide, calibration, calibratedOnly: true, reason: "No calibration guide was detected for this capture." };
    if (!options.calibratedOnly && (options.singleResolution || options.mode === "padding" || (Math.max(width, height) < 640 && !scaleGuide)) && width * height <= MAX_PIXELS) {
      const result = await findVisualTransform(pixels, width, height, { ...options, worker: false, geometryOnly: true });
      calibration = { ...calibration, used: false, method: "fallback" };
      const candidates = rankMarkerCandidates((result.candidates || []).map((geometry) => ({ geometry, markers: result.markers,
        markerSearch: result.markerSearch, refinementState: result.refinementState, scaleGuide, calibration })));
      return { ...result, scaleGuide, calibration, candidates, geometry: candidates[0]?.geometry, highConfidence: Boolean(candidates[0]?.geometry.highConfidence), width, height };
    }
    const deadline = Math.min(options.searchState?.deadline || Infinity, options.deadline || Infinity, Date.now() + 60000);
    let best = null, known = options.calibratedOnly ? null : options.searchState?.seed || options.seed || null;
    let verifiedCurrent = !options.calibratedOnly && Boolean(options.searchState?.seed);
    let seedFromGuide = !options.calibratedOnly && Boolean(options.searchState?.seedFromGuide);
    const candidates = [];
    // Start near a useful middle size. Marker agreement and measured spacing
    // choose the next level; both directions remain available after a weak miss.
    // Every working image comes directly from the original, never a resize chain.
    const sizes = options.searchState?.sizes?.slice() || (options.calibratedOnly ? [] : [16, 8, 4, 2, 1]).map((divisor) => ({ divisor,
      width: Math.round(width / divisor), height: Math.round(height / divisor) }))
      .filter((size, i, all) => (width * height <= MAX_PIXELS || size.width * size.height <= MAX_MARKER_PIXELS) &&
        (size.divisor === 1 || size.width >= 128 && size.height >= 96) &&
        all.findIndex((s) => s.width === size.width && s.height === size.height) === i);
    const startDivisor = known ? markerBasis(known.matrix, known.carrierVersion) / 1.2 : Math.max(width, height) / 1000;
    if (scaleGuide && !options.searchState?.sizes) {
      const proposed = { divisor: scaleGuide.scale, width: Math.round(width / scaleGuide.scale),
        height: Math.round(height / scaleGuide.scale), guided: true };
      // Keep the ordinary level even when dimensions coincide: the short pilot
      // search uses narrower hypotheses and must not replace its full fallback.
      if (proposed.width >= 128 && proposed.height >= 96 && proposed.width * proposed.height <= MAX_MARKER_PIXELS) sizes.push(proposed);
      sizes.sort((a,b) => b.divisor-a.divisor);
    }
    const normalStart = sizes.reduce((best, size, i) => !size.guided && (sizes[best].guided || Math.abs(Math.log2(size.divisor / startDivisor)) <
      Math.abs(Math.log2(sizes[best].divisor / startDivisor))) ? i : best, 0);
    let start = scaleGuide && !options.searchState && sizes.some(size => size.guided) ? sizes.findIndex(size => size.guided) : normalStart;
    const pending = options.searchState?.pending.slice() || sizes.map((_, i) => i);
    const samples = options.searchState?.samples.slice() || [];
    while (pending.length) {
      if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      if (Date.now() >= deadline) {
        best = { ...(best || { found: false }), reason: "Marker discovery reached its search time limit. Retry image recovery if needed." };
        break;
      }
      const index = nextMarkerScale(pending, samples, start, sizes, known);
      pending.splice(pending.indexOf(index), 1);
      const { width: rw, height: rh, divisor, guided } = sizes[index], full = divisor === 1;
      const label = (guided ? scaleGuide?.kind === "edge" ? "Edge-guide size" : "Pilot-guided size" : full ? "Full size" : "1/" + divisor + " size") + " (" + rw + " × " + rh + ")";
      options.onProgress?.("Locating photo markers: " + label + "…");
      const corners = options.corners?.map((p) => ({ x: (p.x + 0.5) * rw / width - 0.5, y: (p.y + 0.5) * rh / height - 0.5 }));
      const scaleMatrix = (h) => [(rw / width) * h[0] + (rw / width - 1) / 2 * h[6],
        (rw / width) * h[1] + (rw / width - 1) / 2 * h[7], (rw / width) * h[2] + (rw / width - 1) / 2 * h[8],
        (rh / height) * h[3] + (rh / height - 1) / 2 * h[6], (rh / height) * h[4] + (rh / height - 1) / 2 * h[7],
        (rh / height) * h[5] + (rh / height - 1) / 2 * h[8], h[6], h[7], h[8]];
      const seed = known ? { ...known, matrix: scaleMatrix(known.matrix),
        initialMatrix: known.initialMatrix && scaleMatrix(known.initialMatrix) } : undefined;
      // Dimensions from a verified header reveal the actual symbol spacing.
      // Avoid levels that put this patch outside the local detector's range.
      if (seed && verifiedCurrent) {
        const basis = markerBasis(seed.matrix, seed.carrierVersion);
        if (basis > 3 || basis < 0.4) continue;
      }
      const image = full ? { pixels, width, height } : await reducePhoto(pixels, width, height, rw, rh, options.signal);
      if (guided) calibration = { ...calibration, attempted: true };
      const remaining = deadline - Date.now();
      const seedBudget = Math.max(1500, remaining / Math.min(3, pending.length + 1));
      // A false pilot gets only a short extra attempt. Every original pyramid
      // level remains pending, with the original reader budgets and checks.
      // Edge evidence gets a short seed attempt. Once a header verifies, the
      // transform reader restores the full deadline for the remaining markers.
      const levelDeadline = guided && scaleGuide?.kind !== "edge" ? Math.min(deadline, Date.now() + 1200) : deadline;
      const workingGuide = guided && scaleGuide ? { ...scaleGuide, fx: scaleGuide.fx * width / rw, fy: scaleGuide.fy * height / rh,
        corners: scaleGuide.corners?.length === 4 ? scaleGuide.corners.map(point => ({
          x: (point.x + .5) * rw / width - .5, y: (point.y + .5) * rh / height - .5 })) : undefined } : null;
      const result = await findVisualTransform(image.pixels, rw, rh, { ...options, corners, seed, singleResolution: true,
        scaleGuide: workingGuide, pilotFirst: Boolean(workingGuide),
        worker: false, geometryOnly: true, deadline: levelDeadline,
        seedDeadline: Math.min(levelDeadline, Date.now() + (guided ? 1200 : seedBudget)),
        onProgress: (text) => options.onProgress?.(label + ": " + text) });
      const lifted = full ? result : liftPhotoResult(result, width, height, rw, rh);
      const header = lifted.markers?.filter((m) => m.verification === "header").sort((a, b) => b.quality - a.quality)[0];
      if (header) { known = { ...header, initialMatrix: lifted.geometry?.matrix || header.initialMatrix }; verifiedCurrent = true;
        seedFromGuide = Boolean(guided || seedFromGuide); }
      for (const geometry of lifted.candidates || []) candidates.push({ geometry, markers: lifted.markers, markerSearch: lifted.markerSearch,
        refinementState: result.refinementState,
        scaleGuide, calibration: { ...calibration, used: Boolean(guided || seedFromGuide), method: guided || seedFromGuide ? "guide" : "fallback",
          localizationResolution: { width: rw, height: rh } }, localizationResolution: { width: rw, height: rh }, photo: true });
      const markerScore = lifted.geometry?.rank ?? (lifted.markers?.length ? 30 + lifted.markers.length * 3 :
        Math.min(20, 20 * Math.max(0, lifted.evidence?.pilotQuality || 0)));
      if (!guided || header) samples.push({ index, score: markerScore });
      if (guided && !header) start = normalStart;
      const rank = (r) => (r?.geometry ? 16 : 0) + (r?.markers?.length || 0);
      if (!best || rank(lifted) >= rank(best)) best = lifted;
      if (options.stopOnHighConfidence !== false && lifted.geometry?.highConfidence) {
        options.onProgress?.("The corner geometry agrees strongly. Reading the most promising pixel grid…");
        break;
      }
    }
    const ranked = rankMarkerCandidates(candidates);
    return { found: false, ...best, width, height, scaleGuide, calibratedOnly: Boolean(options.calibratedOnly), calibration: { ...calibration, ...ranked[0]?.calibration,
      attempted: calibration.attempted }, candidates: ranked, geometry: ranked[0]?.geometry,
      highConfidence: Boolean(ranked[0]?.geometry.highConfidence),
      searchState: { pending, samples, seed: verifiedCurrent ? known : undefined, seedFromGuide, deadline, sizes, scaleGuide, calibration },
      markers: ranked[0]?.markers || best?.markers || [], markerSearch: ranked[0]?.markerSearch || best?.markerSearch };
  }

  async function analyzeNativeMarkers(pixels, width, height, version = CARRIER_V6) {
    assertImage(pixels, width, height);
    const profile = locatorProfile(version), layout = profile && locatorLayout(width, height, version);
    if (!layout || !locatorFits(width, height, version)) return { found: false, markers: [], geometry: null };
    await yieldNow();
    const expectedMarkers = layout.map(patch => ({ id: patch.id, patchWidth: profile.width, patchHeight: profile.height,
      matrix: [1, 0, patch.x, 0, 1, patch.y, 0, 0, 1] }));
    const markers = expectedMarkers.map(patch => readVisualLocator(pixels, width, height, patch.matrix, patch.id, version))
      .filter(marker => marker && marker.originalWidth === width && marker.originalHeight === height);
    const matrix = [1,0,0,0,1,0,0,0,1];
    let edgeMarkerColumns = version === CARRIER_V6 ? 4 : compactCarrier(version) ? 6 : 0;
    if (version === CARRIER_V6 && markers.length) {
      const map = locatorBlockMap(width, height, PREAMBLE_BLOCKS, version);
      for (const strength of STRENGTHS) {
        const probe = await scoreMapped(pixels, width, height, map, width, strength, null, PREAMBLE_BLOCKS);
        const preamble = tryReadPreamble(probe.scores) || tryReadPreamble(probe.bounded);
        if (preamble?.version === version) { edgeMarkerColumns = preamble.edgeMarkerColumns; break; }
      }
    }
    const expectedReferenceMarkers = edgeMarkerColumns ? referenceLayout(width, height, edgeMarkerColumns).map(patch => ({
      id: patch.id, patchWidth: edgeMarkerColumns * 4, patchHeight: 16, matrix: patchTransform(matrix, patch)
    })) : [];
    const referenceMarkers = markers.length && edgeMarkerColumns ? checkReferences(pixels, width, height, matrix,
      { originalWidth: width, originalHeight: height }, true, version, edgeMarkerColumns) : [];
    return { found: Boolean(markers.length), markers, geometry: markers.length ? {
      carrierVersion: version, model: "native", matrix, originalWidth: width, originalHeight: height,
      corners: [{x:0,y:0},{x:width-1,y:0},{x:width-1,y:height-1},{x:0,y:height-1}],
      expectedMarkers, patchWidth: profile.width, patchHeight: profile.height, markerCount: markers.length,
      markerTotal: profile.ids.length, headerCount: markers.length, patternCount: 0, inlierCount: markers.length, fitError: 0,
      referenceMarkers, referenceCount: referenceMarkers.length, expectedReferenceMarkers, edgeMarkers: Boolean(edgeMarkerColumns)
    } : null };
  }

  async function readMarkerCandidates(pixels, width, height, scan, options = {}) {
    options = recoveryOptions(options);
    options.failure ||= { stage: "markers" };
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    // A scan is tied to one raster. Camera buffers must never use a previous
    // frame's geometry as if it had been measured in the newly captured pixels.
    if (!scan || scan.width !== width || scan.height !== height) throw new Error("The marker scan does not match this image.");
    if (canUseReaderWorker(options)) {
      const result = await searchInWorker(pixels, width, height, { ...options, scan }, "read-candidates");
      checkCancelled(options.signal);
      if (result.failure) {
        recordReadFailure(options.failure, result.failure);
        result.failure = { ...options.failure };
      }
      retainVisualResult(pixels, width, height, result);
      return result;
    }
    const selected = recoveryVersions(options);
    const candidates = rankMarkerCandidates((scan.candidates || []).filter((c) => selected.includes(c.geometry.carrierVersion || CARRIER_V6)));
    const markers = (scan.markers || []).filter((m) => selected.includes(m.carrierVersion || scan.geometry?.carrierVersion || CARRIER_V6));
    let best = { found: Boolean(markers.length), unreadable: Boolean(markers.length),
      markers, markerSearch: scan.markerSearch, signature: scan.signature, reason: scan.reason, failure: options.failure,
      scaleGuide: scan.scaleGuide, calibration: calibrationTrace(scan.scaleGuide, scan.calibration) };
    for (let i = 0; i < candidates.length; i++) {
      checkCancelled(options.signal);
      const candidate = candidates[i], geometry = candidate.geometry;
      options.onProgress?.("Reading ranked candidate " + (i + 1) + "/" + candidates.length +
        " (" + geometry.inlierCount + "/" + geometry.markerTotal + " aligned markers)…");
      let recovered = candidate.photo
        ? await readPhotoMapping(pixels, width, height, geometry, options.signal, options.onProgress, candidate.markers,
          { ...options, earlyPayloadProbe: Boolean(candidate.refinementState) })
        : await readVisualMapping(pixels, width, height, geometry, options.signal,
          { failure: options.failure, ...(candidate.refinementState ? { offsets: [0], strengths: [16] } : {}) });
      if (!candidate.photo && !candidate.refinementState && recovered.locatorOnly && geometry.model !== "translation")
        recovered = await readPhotoMapping(pixels, width, height, geometry, options.signal, options.onProgress, candidate.markers, options);
      checkCancelled(options.signal);
      const inspection = describeRecovery(recovered);
      const scaleGuide = candidate.scaleGuide || scan.scaleGuide;
      const calibration = calibrationTrace(scaleGuide, { ...scan.calibration, ...candidate.calibration,
        attempted: Boolean(scan.calibration?.attempted || candidate.calibration?.attempted) });
      const result = { ...inspection, found: true, unreadable: Boolean(recovered.locatorOnly) || !inspection.found,
        carrierVersion: geometry.carrierVersion || CARRIER_V6, geometry: recovered.geometry, readResolution: recovered.readResolution,
        markers: candidate.markers, markerSearch: candidate.markerSearch || scan.markerSearch, signature: scan.signature, scaleGuide, calibration,
        reason: inspection.found && !recovered.locatorOnly ? undefined : "Recovery markers were found, but the payload did not pass its checks." };
      if (!result.unreadable) {
        if (candidate.refinementState) result.earlyPayload = true;
        retainVisualResult(pixels, width, height, result, recovered.readImage);
        return result;
      }
      if (candidate.refinementState) {
        options.onProgress?.("Early payload check did not pass. Continuing the original alignment refinement…");
        const size = candidate.localizationResolution || { width, height };
        const image = size.width === width && size.height === height ? { pixels, width, height }
          : await reducePhoto(pixels, width, height, size.width, size.height, options.signal);
        const refined = await findVisualTransform(image.pixels, image.width, image.height, { ...options,
          mode: candidate.refinementState.mode, earlyPayload: false, refinementState: candidate.refinementState,
          worker: false, geometryOnly: true });
        const lifted = image.width === width && image.height === height ? refined
          : liftPhotoResult(refined, width, height, image.width, image.height);
        const resumed = await readMarkerCandidates(pixels, width, height, { ...scan,
          geometry: lifted.geometry, markers: lifted.markers, markerSearch: lifted.markerSearch,
          candidates: (lifted.candidates || []).map(geometry => ({ ...candidate, geometry,
            markers: lifted.markers, markerSearch: lifted.markerSearch, refinementState: undefined })) },
          { ...options, worker: false, earlyPayload: false, resumeDiscovery: false });
        if (!resumed.unreadable && resumed.found) return { ...resumed, earlyPayloadFallback: true };
      }
      if (i === 0) best = result;
    }
    // Live scans can stop on a high-confidence fit before visiting every scale.
    // If its body fails, keep this exact frame and use the remaining scales,
    // just as ordinary file recovery does. Never borrow the next frame's pixels.
    if (options.resumeDiscovery && !options.calibratedOnly && !scan.calibratedOnly && scan.searchState?.pending.length) {
      const deadline = options.deadline || Date.now() + 60000;
      if (Date.now() < deadline) {
        options.onProgress?.("The marker fit did not decode. Checking the remaining scales of this capture…");
        const remaining = await scanMarkers(pixels, width, height, { ...options,
          searchState: { ...scan.searchState, deadline }, deadline, stopOnHighConfidence: false });
        checkCancelled(options.signal);
        const retried = await readMarkerCandidates(pixels, width, height, remaining, { ...options, resumeDiscovery: false });
        if (retried.found && !retried.unreadable || (retried.markers?.length || 0) > (best.markers?.length || 0)) return retried;
      }
    }
    retainVisualResult(pixels, width, height, best);
    return best;
  }

  function bilinearSample(pixels, width, height, x, y) {
    x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const sample = [0, 0, 0, 255];
    for (let channel = 0; channel < 4; channel++) {
      const a = pixels[(x0 + y0 * width) * 4 + channel], b = pixels[(x1 + y0 * width) * 4 + channel];
      const c = pixels[(x0 + y1 * width) * 4 + channel], d = pixels[(x1 + y1 * width) * 4 + channel];
      sample[channel] = roundHalfToEven(a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy);
    }
    return sample;
  }

  async function resampleReadSpace(pixels, width, height, origW, origH, scaleX, scaleY, phaseX, phaseY) {
    const out = new Uint8Array(origW * origH * 4);
    for (let y = 0; y < origH; y++) {
      if ((y & 31) === 31) await yieldNow();
      for (let x = 0; x < origW; x++) {
        out.set(bilinearSample(pixels, width, height, phaseX + scaleX * x, phaseY + scaleY * y), (x + y * origW) * 4);
      }
    }
    return out;
  }

  function cleanLocators(pixels, width, height, output, version = CARRIER_V6, edgeMarkerColumns = version === CARRIER_V6 ? 4 : 6, colourWavelets = false) {
    if (version !== CARRIER_V3) return cleanBlendedLocators(pixels, width, height, output, version, edgeMarkerColumns, colourWavelets);
    const profile = locatorProfile(version);
    const { order: locatorOrder, columns: LOCATOR_COLUMNS, cell: LOCATOR_CELL } = profile;
    for (const patch of locatorLayout(width, height, version)) {
      const header = locatorHeader(width, height, patch.id, version);
      for (let slot = 0; slot < 96; slot++) {
        const cell = locatorOrder[slot], bit = WORD_BITS[header[Math.floor(slot / 12)] * 12 + slot % 12];
        const x = patch.x + cell % LOCATOR_COLUMNS * LOCATOR_CELL, y = patch.y + Math.floor(cell / LOCATOR_COLUMNS) * LOCATOR_CELL;
        let projection = 0, energy = 0;
        for (let dy = 0; dy < LOCATOR_CELL; dy++) for (let dx = 0; dx < LOCATOR_CELL; dx++) {
          const k = scaleWeight(LOCATOR_STRENGTH, shapeWeight(Math.floor(dx * 4 / LOCATOR_CELL), Math.floor(dy * 4 / LOCATOR_CELL), bit));
          const p = (x + dx + (y + dy) * width) * 4;
          projection += (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3 * k; energy += k * k;
        }
        const amount = Math.max(0, Math.min(1, projection / energy));
        for (let dy = 0; dy < LOCATOR_CELL; dy++) for (let dx = 0; dx < LOCATOR_CELL; dx++) {
          const delta = amount * scaleWeight(LOCATOR_STRENGTH, shapeWeight(Math.floor(dx * 4 / LOCATOR_CELL), Math.floor(dy * 4 / LOCATOR_CELL), bit));
          const p = (x + dx + (y + dy) * width) * 4;
          for (let c = 0; c < 3; c++) output[p + c] = clampChannel(pixels[p + c] - delta);
        }
      }
    }
  }

  function cleanBlendedLocators(pixels, width, height, output, version, edgeMarkerColumns = version === CARRIER_V6 ? 4 : 6, colourWavelets = false) {
    const profile = locatorProfile(version);
    const channels = version === CARRIER_V6 && colourWavelets ? 3 : 1;
    const patches = locatorLayout(width, height, version).concat(compactCarrier(version) ? referenceLayout(width, height, edgeMarkerColumns) : []);
    for (const patch of patches) {
      const main = profile.ids.includes(patch.id), p = main ? profile : referenceProfile(version, edgeMarkerColumns);
      const header = locatorHeader(width, height, patch.id, version);
      for (let slot = 0; slot < p.order.length; slot++) {
        const cell = p.order[slot], coded = slot % (main ? 96 : 24);
        const bit = main ? WORD_BITS[header[Math.floor(coded / 12)] * 12 + coded % 12] : referenceBit(header, slot, edgeMarkerColumns), kernel = p.kernels[bit];
        const x = patch.x + cell % p.columns * p.cell, y = patch.y + Math.floor(cell / p.columns) * p.cell;
        const projection = new Float64Array(channels); let energy = 0;
        for (let i = 0; i < kernel.length; i++) {
          const index = (x + i % p.cell + (y + Math.floor(i / p.cell)) * width) * 4;
          for (let c = 0; c < channels; c++) projection[c] += (channels === 1
            ? (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3 : pixels[index + c]) * kernel[i];
          energy += kernel[i] ** 2;
        }
        const maximum = (version === CARRIER_V4 ? V4_MARKER_PEAK / 16 : V5_MARKER_PEAK / 16) * blendedLocatorGain(version, p, cell, main);
        const limit = channels === 3 ? maximum * (1 + COLOUR_WAVELET_TINT) + 3 / 16 : maximum;
        const amounts = projection.map(value => Math.max(0, Math.min(limit, value / energy)));
        for (let i = 0; i < kernel.length; i++) {
          const index = (x + i % p.cell + (y + Math.floor(i / p.cell)) * width) * 4;
          for (let c = 0; c < 3; c++) output[index + c] = clampChannel(pixels[index + c] - amounts[channels === 1 ? 0 : c] * kernel[i]);
        }
      }
    }
  }

  async function writeSignal(reference, image, width, height, framed, strength, version, map = null, signalPolicy = null) {
    const columns = Math.floor(width / BLOCK);
    const blockCount = map ? map.length : columns * Math.floor(height / BLOCK);
    const payloadBlocks = blockCount - carrierOverhead(version);
    if (payloadBlocks < 1 || framed.length > MAX_FRAMED) {
      throw new Error("This image is too small for that message. Use a larger picture or a shorter message.");
    }
    const bitsPerByte = payloadCodeBits(payloadBlocks, framed.length, version);
    if (bitsPerByte === 0) {
      throw new Error("This image is too small for that message. Use a larger picture or a shorter message.");
    }
    const parityBits = bitsPerByte === 12 ? 4 : 1;
    // V5's CRC-protected header stores headroom in two-level increments.
    // Bits (7,0): (0,1) original; (0,0) subtle edge guide;
    // (1,1) historical 3-level FFT pilot; (1,0) historical 16-level FFT pilot.
    // Payload frames, parity and capacity are unchanged.
    const pilot = compactCarrier(version) && signalPolicy?.scalePilot;
    const flags = (pilot || compactCarrier(version) && signalPolicy?.edgeGuide ? 0 : FLAGS) | (parityBits === 1 ? ONE_PARITY : 0) |
      (compactCarrier(version) ? (((signalPolicy?.rangeHeadroom || 0) / 2) << 2) |
        (signalPolicy?.scalePilot ? SCALE_PILOT_FLAG : 0) : 0) |
      (version === CARRIER_V6 && signalPolicy?.colourWavelets ? V6_COLOUR_FLAG : 0);
    const bytes = new Uint8Array(9);
    bytes[0] = version === CARRIER_V6 ? signalPolicy?.edgeMarkers === false ? V6_NO_EDGE_MARKERS_MAGIC : V6_MAGIC : MAGIC;
    bytes[1] = locatorProfile(version) ? version : CARRIER_V1;
    bytes[2] = flags;
    // The high length bits identify the range curve and V6 allocation layout;
    // both are covered by the existing preamble CRC.
    writeU32(bytes, 3, framed.length | (version === CARRIER_V6
      ? (signalPolicy?.rangeHeadroom ? CURVED_RANGE_FLAG : 0) | RISK_ALLOCATION_FLAG |
        ((signalPolicy?.rangeCurve === "sinusoidal" ? V6_GENTLE_CURVE :
          Math.round(normalizeBrightnessCurve(signalPolicy?.brightnessCurve) * V6_BRIGHTNESS_LEVELS)) << V6_BRIGHTNESS_SHIFT) |
        (signalPolicy?.luminanceCurve ? V6_LUMINANCE_FLAG : 0)
      : compactCarrier(version) && signalPolicy?.rangeCurve === "sinusoidal" ? CURVED_RANGE_FLAG : 0));
    const crc = crc32(bytes, 0, 7) & 0xFFFF;
    bytes[7] = crc & 0xFF;
    bytes[8] = (crc >> 8) & 0xFF;
    const amplitudeCache = new Int16Array(columns * Math.floor(height / BLOCK));
    amplitudeCache.fill(-1);
    const preambleOrder = scatterOrder(PREAMBLE_BLOCKS, SEED);
    await writeBits(reference, image, width, columns, map ? preambleOrder.map((block) => map[block]) : preambleOrder, (slot) => {
      const bitIndex = slot % 72;
      return (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    }, strength, amplitudeCache, signalPolicy);
    if (version === CARRIER_V6) {
      const layout = riskLayout(map, width, height);
      const risks = await measureRiskMap(reference, layout, strength, amplitudeCache, signalPolicy);
      const metadata = packRiskMap(risks, layout, framed.length, bitsPerByte);
      const metadataSlots = Uint32Array.from(layout.order.subarray(0, RISK_MAP_BLOCKS), (position) => map[PREAMBLE_BLOCKS + position]);
      await writeBits(reference, image, width, columns, metadataSlots,
        (slot) => codedBit(metadata, slot % (RISK_MAP_BYTES * 12), 12), strength, amplitudeCache, signalPolicy);
      const payloadPolicy = signalPolicy?.colourWavelets ? { ...signalPolicy, tintPayload: true } : signalPolicy;
      const allocation = await walkRiskAllocation(risks, layout, framed.length * bitsPerByte, (bit, index) => {
        const physical = map[index];
        applyBit(reference, image, width, physical % columns, Math.floor(physical / columns),
          codedBit(framed, bit, bitsPerByte), strength, amplitudeCache, payloadPolicy);
      });
      return { ...repetitionBudget(payloadBlocks, framed.length, bitsPerByte), copies: allocation.minCopies,
        riskAllocation: { ...allocation, mapCorrections: 0 } };
    }
    const payloadOrder = scatterOrder(payloadBlocks, SEED);
    const payloadSlots = new Uint32Array(payloadBlocks);
    for (let slot = 0; slot < payloadBlocks; slot++) {
      const block = PREAMBLE_BLOCKS + payloadOrder[slot];
      payloadSlots[slot] = map ? map[block] : block;
    }
    await writeBits(reference, image, width, columns, payloadSlots, (slot) => codedBit(framed, slot % (framed.length * bitsPerByte), bitsPerByte), strength, amplitudeCache, signalPolicy);
    return {
      ...repetitionBudget(payloadBlocks, framed.length, bitsPerByte)
    };
  }

  function codedBit(data, index, bitsPerByte) {
    if (bitsPerByte === 12) {
      const value = data[(index / 12) | 0];
      return WORD_BITS[value * 12 + (index % 12)];
    }
    const bit = index % 9;
    const value = data[(index / 9) | 0];
    if (bit === 8) return evenParity(value);
    return (value >> (7 - bit)) & 1;
  }

  function evenParity(value) {
    let parity = 0;
    for (let i = 0; i < 8; i++) parity ^= (value >> i) & 1;
    return parity;
  }

  function tryReadPreamble(scores) {
    if (!scores || scores.length < PREAMBLE_BLOCKS) return null;
    const order = scatterOrder(PREAMBLE_BLOCKS, SEED);
    const totals = new Int32Array(72);
    for (let slot = 0; slot < PREAMBLE_BLOCKS; slot++) {
      totals[slot % 72] = (totals[slot % 72] + scores[order[slot]]) | 0;
    }
    const bytes = new Uint8Array(9);
    for (let bit = 0; bit < 72; bit++) {
      if (totals[bit] > 0) bytes[bit >> 3] |= 1 << (7 - (bit & 7));
    }
    if (bytes[1] === CARRIER_V6 ? bytes[0] !== V6_MAGIC && bytes[0] !== V6_NO_EDGE_MARKERS_MAGIC : bytes[0] !== MAGIC) return null;
    const crc = crc32(bytes, 0, 7) & 0xFFFF;
    const stored = bytes[7] | (bytes[8] << 8);
    if (crc !== stored) return null;
    const storedLength = readU32(bytes, 3);
    const curvedRange = Boolean(storedLength & CURVED_RANGE_FLAG);
    const brightnessCode = (storedLength >>> V6_BRIGHTNESS_SHIFT) & 255;
    const gentleCurve = bytes[1] === CARRIER_V6 && brightnessCode === V6_GENTLE_CURVE;
    if (curvedRange && !compactCarrier(bytes[1])) return null;
    // CB identifies square 4x4 midpoint references; CA omits them. Older V6
    // development layouts are rejected rather than given the wrong payload map.
    if (bytes[1] === CARRIER_V6 && (brightnessCode > V6_GENTLE_CURVE || !(storedLength & RISK_ALLOCATION_FLAG) ||
      gentleCurve && (storedLength & V6_LUMINANCE_FLAG) ||
      (bytes[2] & FLAGS) || curvedRange !== Boolean(bytes[2] & 0x7c) ||
      !curvedRange && (brightnessCode || (storedLength & V6_LUMINANCE_FLAG)))) return null;
    const luminanceCurve = bytes[1] === CARRIER_V6 && Boolean(storedLength & V6_LUMINANCE_FLAG);
    const brightnessCurve = bytes[1] === CARRIER_V6 && !gentleCurve ? brightnessCode / V6_BRIGHTNESS_LEVELS : undefined;
    const framedLength = storedLength & (bytes[1] === CARRIER_V6 ? V6_FRAME_LENGTH_MASK : 0x7FFFFFFF);
    if (framedLength < 1 || framedLength > MAX_FRAMED) return null;
    return { version: bytes[1], flags: bytes[2], framedLength, colourWavelets: bytes[1] === CARRIER_V6 && Boolean(bytes[2] & V6_COLOUR_FLAG), luminanceCurve, brightnessCurve,
      edgeMarkers: compactCarrier(bytes[1]) && bytes[0] !== V6_NO_EDGE_MARKERS_MAGIC,
      edgeMarkerColumns: bytes[1] === CARRIER_V6 ? bytes[0] === V6_MAGIC ? 4 : 0 : compactCarrier(bytes[1]) ? 6 : 0,
      rangeCurve: bytes[1] === CARRIER_V6 ? curvedRange ? gentleCurve ? "sinusoidal" : luminanceCurve ? "luminance-v2" : "magnifier-3-16" : "linear" : curvedRange ? "sinusoidal" : "linear" };
  }

  function combineScores(blockScores, order, codedBits) {
    const combined = new Int32Array(codedBits);
    for (let slot = 0; slot < blockScores.length; slot++) {
      const index = slot % codedBits;
      combined[index] = (combined[index] + blockScores[order[slot]]) | 0;
    }
    return combined;
  }

  function decodeOneParity(scores, byteCount) {
    let corrections = 0;
    const output = new Uint8Array(byteCount);
    for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
      const start = byteIndex * 9;
      let value = 0;
      let parity = 0;
      let weakest = 8;
      let weakestMag = Math.abs(scores[start + 8]);
      for (let bit = 0; bit < 8; bit++) {
        const score = scores[start + bit];
        const bitValue = score > 0 ? 1 : 0;
        value = (value << 1) | bitValue;
        parity ^= bitValue;
        const magnitude = Math.abs(score);
        if (magnitude < weakestMag) {
          weakestMag = magnitude;
          weakest = bit;
        }
      }
      const parityBit = scores[start + 8] > 0 ? 1 : 0;
      if (parity !== parityBit) {
        corrections++;
        if (weakest < 8) value ^= 1 << (7 - weakest);
      }
      output[byteIndex] = value;
    }
    return { bytes: output, corrections };
  }

  function decodeSoftRange(scores, output, first, last) {
    let corrections = 0;
    for (let byteIndex = first; byteIndex < last; byteIndex++) {
      const start = byteIndex * 12;
      let bestValue = 0;
      let best = -Infinity;
      let bestMisses = 2147483647;
      for (let value = 0; value < 256; value++) {
        let match = 0;
        let misses = 0;
        const origin = value * 12;
        for (let bit = 0; bit < 12; bit++) {
          const hypothesis = WORD_BITS[origin + bit];
          const score = scores[start + bit];
          match += hypothesis === 1 ? score : -score;
          if ((score > 0 && hypothesis === 0) || (score < 0 && hypothesis === 1)) misses++;
        }
        if (match > best || (match === best && (misses < bestMisses || (misses === bestMisses && value < bestValue)))) {
          best = match;
          bestValue = value;
          bestMisses = misses;
        }
      }
      output[byteIndex] = bestValue;
      if (bestMisses > 0) corrections++;
    }
    return corrections;
  }

  function decodeSoft(scores, byteCount) {
    const bytes = new Uint8Array(byteCount);
    return { bytes, corrections: decodeSoftRange(scores, bytes, 0, byteCount) };
  }

  async function decodeSoftPayload(scores, byteCount, signal) {
    const bytes = new Uint8Array(byteCount);
    let corrections = 0;
    for (let first = 0; first < byteCount; first += 1024) {
      if (first) await yieldNow();
      checkCancelled(signal);
      corrections += decodeSoftRange(scores, bytes, first, Math.min(byteCount, first + 1024));
    }
    return { bytes, corrections };
  }

  async function readFramedScores(scores, signal, failure, grid) {
    checkCancelled(signal);
    const preamble = tryReadPreamble(scores);
    if (!preamble) throw frameError("The image does not contain a matching carrier header.");
    if ((preamble.version !== CARRIER_V1 && !locatorProfile(preamble.version)) ||
      preamble.framedLength < HEADER || preamble.framedLength > MAX_FRAMED) {
      throw frameError("Unsupported image carrier.");
    }
    const allowed = compactCarrier(preamble.version) ? (ONE_PARITY | 0xfc) : ONE_PARITY;
    const scalePilot = preamble.version === CARRIER_V5 && Boolean(preamble.flags & SCALE_PILOT_FLAG);
    const strongPilot = scalePilot && !(preamble.flags & FLAGS);
    const edgeGuide = compactCarrier(preamble.version) && !scalePilot && !(preamble.flags & FLAGS);
    if ((preamble.flags & ~allowed) !== (strongPilot || edgeGuide ? 0 : FLAGS)) throw frameError("The carrier flags do not match this profile.");
    const rangeHeadroom = compactCarrier(preamble.version) ? ((preamble.flags >>> 2) & 31) * 2 : 0;
    const scalePilotAmplitude = scalePilot ? (strongPilot ? SCALE_PILOT.amplitude : LEGACY_SCALE_PILOT_AMPLITUDE) : 0;
    if (rangeHeadroom > 62) throw frameError("Unsupported carrier range adjustment.");
    const bitsPerByte = (preamble.flags & ONE_PARITY) !== 0 ? 9 : 12;
    const payloadBlocks = scores.length - carrierOverhead(preamble.version);
    const codedBits = preamble.framedLength * bitsPerByte;
    recordReadFailure(failure, { stage: "header", reason: "Wavelet carrier header verified; payload reading did not complete." });
    if (payloadBlocks < codedBits) throw frameError("The image does not hold a complete copy of the payload.");
    let combined, riskAllocation;
    if (preamble.version === CARRIER_V6) {
      if (!grid || grid.map?.length !== scores.length) throw frameError("The native grid for the repetition map is unavailable.");
      const layout = riskLayout(grid.map, grid.width, grid.height);
      const metadata = readRiskMap(scores, layout, preamble.framedLength, bitsPerByte, failure);
      combined = new Float64Array(codedBits);
      const allocation = await walkRiskAllocation(metadata.risks, layout, codedBits,
        (bit, index, weight) => { combined[bit] += scores[index] * weight; }, signal);
      riskAllocation = { ...allocation, mapCorrections: metadata.corrections };
    } else {
      const order = scatterOrder(payloadBlocks, SEED);
      combined = combineScores(scores.subarray(PREAMBLE_BLOCKS), order, codedBits);
    }
    const decoded = bitsPerByte === 12
      ? await decodeSoftPayload(combined, preamble.framedLength, signal)
      : decodeOneParity(combined, preamble.framedLength);
    checkCancelled(signal);
    return {
      bytes: decoded.bytes,
      corrections: decoded.corrections,
      ...repetitionBudget(payloadBlocks, preamble.framedLength, bitsPerByte),
      ...(riskAllocation ? { copies: riskAllocation.minCopies, riskAllocation } : {}),
      carrierVersion: preamble.version,
      rangeHeadroom, rangeCurve: preamble.rangeCurve, brightnessCurve: preamble.brightnessCurve, luminanceCurve: preamble.luminanceCurve,
      colourWavelets: preamble.colourWavelets, scalePilot, scalePilotAmplitude, edgeGuide, edgeMarkers: preamble.edgeMarkers, edgeMarkerColumns: preamble.edgeMarkerColumns
    };
  }

  function buildShapes(strength) {
    const difference = new Float64Array(16);
    const common = new Float64Array(16);
    let mean = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const one = scaleWeight(strength, WAVELET[x - y + 3]);
        const zero = scaleWeight(strength, WAVELET[x + y]);
        const i = x + y * 4;
        difference[i] = one - zero;
        common[i] = (one + zero) / 2;
        mean += common[i] / 16;
      }
    }
    for (let i = 0; i < 16; i++) common[i] -= mean;
    return { difference, common };
  }

  async function scoreBlocks(pixels, width, columns, rows, difference, common, signal) {
    checkCancelled(signal);
    let differenceEnergy = 0;
    for (let i = 0; i < 16; i++) differenceEnergy += difference[i] * difference[i];
    const scores = new Int32Array(columns * rows);
    const bounded = new Int32Array(scores.length);
    const block = new Float64Array(16);
    for (let row = 0; row < rows; row++) {
      if ((row & 15) === 15) { await yieldNow(); checkCancelled(signal); }
      for (let column = 0; column < columns; column++) {
        let projection = 0;
        const originY = row * 4;
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const i = x + y * 4;
            const pixel = (column * 4 + x + (originY + y) * width) * 4;
            block[i] = (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3;
            projection += block[i] * difference[i];
          }
        }
        let noiseEnergy = 25;
        for (let k = 0; k < NOISE_KERNELS.length; k++) {
          let coefficient = 0;
          const kernel = NOISE_KERNELS[k];
          for (let i = 0; i < 16; i++) coefficient += block[i] * kernel[i];
          noiseEnergy += coefficient * coefficient;
        }
        const index = column + row * columns;
        scores[index] = roundHalfToEven(100 * projection / Math.sqrt(noiseEnergy));
        const bound = differenceEnergy / 2;
        const clamped = projection < -bound ? -bound : (projection > bound ? bound : projection);
        bounded[index] = roundHalfToEven(100 * clamped / 5);
      }
    }
    return { scores, bounded };
  }

  async function tryLayout(scores, signal, failure, layout) {
    let framed;
    try {
      framed = await readFramedScores(scores, signal, failure, layout);
      const unpacked = await unpackFrame(framed.bytes);
      checkCancelled(signal);
      return {
        payload: unpacked.payload,
        strength: unpacked.strength,
        corrections: framed.corrections,
        copies: framed.copies,
        parityBits: framed.parityBits,
        repetitionRatio: framed.repetitionRatio,
        framedBytes: framed.framedBytes,
        riskAllocation: framed.riskAllocation,
        passwordProtected: unpacked.passwordProtected,
        bundle: unpacked.bundle,
        formatVersion: unpacked.formatVersion,
        carrierVersion: framed.carrierVersion,
        rangeHeadroom: framed.rangeHeadroom,
        rangeCurve: framed.rangeCurve,
        brightnessCurve: framed.brightnessCurve,
        luminanceCurve: framed.luminanceCurve,
        colourWavelets: framed.colourWavelets,
        scalePilot: framed.scalePilot,
        scalePilotAmplitude: framed.scalePilotAmplitude,
        edgeGuide: framed.edgeGuide,
        edgeMarkers: framed.edgeMarkers,
        edgeMarkerColumns: framed.edgeMarkerColumns
      };
    } catch (error) {
      if (error && error.code === "frame") {
        if (framed) recordReadFailure(failure, {
          stage: error.message === "Fingerprint checksum failed." ? "checksum" : "payload",
          corrections: framed.corrections, framedBytes: framed.framedBytes, parityBits: framed.parityBits,
          reason: error.message
        });
        return null;
      }
      throw error;
    }
  }

  async function tryReadAt(pixels, width, height, strength, signal, failure) {
    const columns = Math.floor(width / BLOCK);
    const rows = Math.floor(height / BLOCK);
    const blockCount = columns * rows;
    if (blockCount <= PREAMBLE_BLOCKS || blockCount > MAX_BLOCKS) return null;
    strength = Math.max(1, Math.min(32, strength | 0));
    const shapes = buildShapes(strength);
    const scored = await scoreBlocks(pixels, width, columns, rows, shapes.difference, shapes.common, signal);
    return (await tryLayout(scored.scores, signal, failure)) || (await tryLayout(scored.bounded, signal, failure));
  }

  async function readNative(pixels, width, height, version, strength, signal, map, failure = { stage: "wavelets" }) {
    checkCancelled(signal);
    if (!pixels || width < BLOCK || height < BLOCK || pixels.length !== width * height * 4) return null;
    if (width * height > MAX_PIXELS) return null;
    if (locatorProfile(version) && !locatorFits(width, height, version)) return null;
    const preambleMap = locatorProfile(version)
      ? (map ? map.subarray(0, PREAMBLE_BLOCKS) : locatorBlockMap(width, height, PREAMBLE_BLOCKS, version))
      : Uint32Array.from({ length: PREAMBLE_BLOCKS }, (_, i) => i);
    if (Math.floor(width / BLOCK) * Math.floor(height / BLOCK) <= PREAMBLE_BLOCKS || preambleMap.length < PREAMBLE_BLOCKS) return null;
    // Generated files already have a known pixel lattice. Check that carrier's
    // repeated header directly, without requiring a marker fit or resize search.
    // Only allocate/score the entire payload map after the header has passed CRC.
    // The writer can reduce amplitude per block to avoid clipping. Start with
    // its nominal strength, then retain the original reader's other templates.
    const amplitudes = strength ? [strength, ...STRENGTHS.filter((value) => value !== strength)] : STRENGTHS;
    for (const amplitude of amplitudes) {
      const probe = await scoreMapped(pixels, width, height, preambleMap, width, amplitude, null, PREAMBLE_BLOCKS, signal);
      const preamble = tryReadPreamble(probe.scores) || tryReadPreamble(probe.bounded);
      if (!preamble || preamble.version !== version) continue;
      let found;
      if (locatorProfile(version)) {
        map ||= locatorBlockMap(width, height, Infinity, version, preamble.edgeMarkerColumns);
        const scored = await scoreMapped(pixels, width, height, map, width, amplitude, null, map.length, signal);
        const layout = { map, width, height };
        found = (await tryLayout(scored.scores, signal, failure, layout)) || (await tryLayout(scored.bounded, signal, failure, layout));
      } else found = await tryReadAt(pixels, width, height, amplitude, signal, failure);
      if (found?.carrierVersion === version) return { ...found, origWidth: width, origHeight: height,
        scaleX: 1, scaleY: 1, phaseX: 0, phaseY: 0 };
    }
    return null;
  }

  async function recover(pixels, width, height, options = {}) {
    options = recoveryOptions(options);
    const failure = options.failure ||= { stage: "wavelets" };
    checkCancelled(options.signal);
    if (!pixels || pixels.length !== width * height * 4 || width < BLOCK || height < BLOCK) return null;
    if (width * height > MAX_INPUT_PIXELS) throw new Error("This photo exceeds the 32 megapixel input limit.");
    const versions = recoveryVersions(options);
    if (options.nativeOnly) {
      for (const version of versions) {
        const found = await readNative(pixels, width, height, version, options.strength, options.signal, undefined, failure);
        if (found) return found;
      }
      return null;
    }
    const visual = visualMappings.get(pixels);
    if (visual && visual.width === width && visual.height === height &&
      versions.includes(visual.carrierVersion || visual.geometry?.carrierVersion || CARRIER_V6)) {
      const diagnostic = { scaleGuide: visual.diagnostics?.scaleGuide || visual.scaleGuide,
        calibration: visual.diagnostics?.calibration || visual.calibration };
      if (visual.unreadable) return { locatorOnly: true, carrierVersion: visual.carrierVersion || visual.geometry?.carrierVersion || CARRIER_V6,
        failure: visual.diagnostics?.failure || failure, ...diagnostic };
      if (visual.readResolution) {
        const resolution = visual.readResolution;
        const image = visual.workingImage || { ...await rectifyPhoto(pixels, width, height, resolution.width, resolution.height,
          resolution.photoMatrix, options.signal, resolution.phaseCorrection), phaseCorrection: resolution.phaseCorrection };
        visual.workingImage = image;
        const recovered = await readVisualMapping(image.pixels, image.width, image.height, resolution.geometry, options.signal, { channel: resolution.channel, failure });
        return { ...photoReadResult(recovered, image, geometryAt(visual.geometry, resolution.photoMatrix)), ...diagnostic };
      }
      return { ...await readVisualMapping(pixels, width, height, visual.geometry, options.signal, { failure }), ...diagnostic };
    }
    for (const version of versions) {
      const direct = await readNative(pixels, width, height, version, undefined, options.signal, undefined, failure);
      if (direct) return direct;
    }
    const native = await findLocator(pixels, width, height, true, false, options.signal, options);
    if (native) {
      const found = await readMapped(pixels, width, height, native, true, options.signal, failure);
      if (!found.locatorOnly) return found;
      return readMapped(pixels, width, height, native, false, options.signal, failure);
    }
    if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    options.onProgress?.("Checking common image resize ratios…");
    const locator = await findLocator(pixels, width, height, false, options.quickOnly, options.signal, options);
    return locator ? readMapped(pixels, width, height, locator, false, options.signal, failure) : null;
  }

  function describeRecovery(recovery) {
    if (!recovery) return { found: false };
    if (recovery.locatorOnly) return { found: true, unreadable: true, carrierVersion: recovery.carrierVersion || CARRIER_V6, geometry: recovery.geometry,
      failure: recovery.failure, scaleGuide: recovery.scaleGuide, calibration: calibrationTrace(recovery.scaleGuide, recovery.calibration) };
    let content;
    try {
      if (recovery.passwordProtected) validateEnvelope(recovery.payload, recovery.bundle);
      else if (recovery.bundle) content = unpackBundle(recovery.payload);
      else decodeUtf8(recovery.payload);
    } catch {
      return { found: false };
    }
    return {
      found: true,
      passwordProtected: recovery.passwordProtected,
      formatVersion: recovery.formatVersion,
      hasAttachments: content ? content.attachments.length > 0 : recovery.bundle,
      toneReferenceBytes: content?.toneProfile?.length || 0,
      carrierVersion: recovery.carrierVersion,
      geometry: recovery.geometry,
      readResolution: recovery.readResolution,
      strength: recovery.strength,
      rangeHeadroom: recovery.rangeHeadroom,
      rangeCurve: recovery.rangeCurve,
      brightnessCurve: recovery.brightnessCurve,
      luminanceCurve: recovery.luminanceCurve,
      colourWavelets: recovery.colourWavelets,
      scalePilot: recovery.scalePilot,
      scalePilotAmplitude: recovery.scalePilotAmplitude,
      edgeGuide: recovery.edgeGuide,
      edgeMarkers: recovery.edgeMarkers,
      edgeMarkerColumns: recovery.edgeMarkerColumns,
      scaleGuide: recovery.scaleGuide,
      calibration: calibrationTrace(recovery.scaleGuide, recovery.calibration,
        recovery.calibration?.method || (recovery.scaleX === 1 && recovery.scaleY === 1 ? "native" : "fallback")),
      repetitionRatio: recovery.repetitionRatio,
      copies: recovery.copies,
      parityBits: recovery.parityBits,
      framedBytes: recovery.framedBytes,
      riskAllocation: recovery.riskAllocation,
      corrections: recovery.corrections,
      decodedWidth: recovery.origWidth,
      decodedHeight: recovery.origHeight
    };
  }

  async function inspectNativeFile(pixels, width, height, options = {}) {
    assertImage(pixels, width, height);
    checkCancelled(options.signal);
    // Browse supplies an original file, not a camera raster. Its V6 top-left
    // marker has a fixed 50x50 footprint at (8,8), inside the upper-left quarter.
    // Do not build a pyramid, FFT, worker or whole-image scores on a miss.
    if (!locatorFits(width, height, CARRIER_V6)) return { found: false, nativeFile: true, failure: { stage: "marker" } };
    const matrix = [1, 0, LOCATOR_INSET, 0, 1, LOCATOR_INSET, 0, 0, 1];
    const marker = readVisualLocator(pixels, width, height, matrix, 0, CARRIER_V6);
    if (!marker) return { found: false, nativeFile: true, failure: { stage: "marker" } };
    const failure = { stage: "wavelets" };
    const unreadable = { found: true, unreadable: true, nativeFile: true, carrierVersion: CARRIER_V6,
      markers: [marker], failure, reason: "A version 6 marker was found, but the native contents could not be verified. Use Image recovery options for a changed or damaged image." };
    if (marker.originalWidth !== width || marker.originalHeight !== height)
      return { ...unreadable, failure: { stage: "dimensions", reason: "The image dimensions differ from those stored in its marker." } };
    options.onProgress?.("Version 6 marker verified. Reading the native payload…");
    const recovered = await readNative(pixels, width, height, CARRIER_V6, undefined, options.signal, undefined, failure);
    checkCancelled(options.signal);
    if (!recovered) return unreadable;
    const result = describeRecovery(recovered);
    return result.found ? { ...result, nativeFile: true } : unreadable;
  }

  async function inspect(pixels, width, height, options = {}) {
    options = recoveryOptions(options);
    options.failure ||= { stage: "wavelets" };
    assertImage(pixels, width, height);
    if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    // Ordinary file imports retain the cheap direct reader. Camera discovery
    // uses scanMarkers instead, and reads only the ranked retained captures.
    if (options.background && canUseReaderWorker(options)) {
      const result = await searchInWorker(pixels, width, height, options, "inspect");
      if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
      retainVisualResult(pixels, width, height, result);
      return result;
    }
    options.onProgress?.("Reading the image at its original size…");
    const recovery = await recover(pixels, width, height, { ...options, quickOnly: options.quickOnly || options.automatic === true });
    if (options.signal?.aborted) throw new DOMException("Search cancelled.", "AbortError");
    const direct = { ...describeRecovery(recovery), ...(!recovery ? { failure: options.failure } : {}) };
    if (options.nativeOnly || !options.automatic || (direct.found && !direct.unreadable)) return direct;
    // One perspective search also retains translation/affine estimates. Running
    // the three manual modes in sequence would repeat the FFT and seed searches.
    options.onProgress?.("Looking for encoded contents in a resized, padded or photographed image…");
    const transformed = await findVisualTransform(pixels, width, height, { ...options, mode: "perspective" });
    if (transformed.found || !direct.found) return transformed;
    // A weak spectral signature must not erase a checksum-valid native marker.
    return { ...transformed, ...direct };
  }

  async function decode(pixels, width, height, password, options = {}) {
    const failure = { stage: "wavelets" };
    const recovery = await recover(pixels, width, height, { ...options, failure });
    checkCancelled(options.signal);
    if (!recovery) return { status: "none", failure };
    const diagnostic = { scaleGuide: recovery.scaleGuide, calibration: calibrationTrace(recovery.scaleGuide, recovery.calibration,
      recovery.calibration?.method || (recovery.scaleX === 1 && recovery.scaleY === 1 ? "native" : "fallback")) };
    if (recovery.locatorOnly) return { status: "markers", failure: recovery.failure || failure,
      carrierVersion: recovery.carrierVersion || CARRIER_V6, geometry: recovery.geometry, scaleX: recovery.scaleX, scaleY: recovery.scaleY, ...diagnostic };
    if (recovery.passwordProtected && !password) {
      return { status: "password", strength: recovery.strength, repetitionRatio: recovery.repetitionRatio,
        copies: recovery.copies, parityBits: recovery.parityBits, framedBytes: recovery.framedBytes,
        riskAllocation: recovery.riskAllocation,
        corrections: recovery.corrections, decodedWidth: recovery.origWidth, decodedHeight: recovery.origHeight, ...diagnostic };
    }
    try {
      const textBytes = recovery.passwordProtected
        ? await decryptEnvelope(recovery.payload, password, recovery.bundle)
        : recovery.payload;
      try {
        checkCancelled(options.signal);
        const content = recovery.bundle ? unpackBundle(textBytes) : { text: decodeUtf8(textBytes), attachments: [] };
        return {
          status: "success",
          ...content,
          formatVersion: recovery.formatVersion,
          carrierVersion: recovery.carrierVersion,
          geometry: recovery.geometry,
          readResolution: recovery.readResolution,
          visualTransform: recovery.visualTransform,
          scaleX: recovery.scaleX,
          scaleY: recovery.scaleY,
          passwordProtected: recovery.passwordProtected,
          strength: recovery.strength,
          rangeHeadroom: recovery.rangeHeadroom,
          rangeCurve: recovery.rangeCurve,
          brightnessCurve: recovery.brightnessCurve,
          luminanceCurve: recovery.luminanceCurve,
          colourWavelets: recovery.colourWavelets,
          scalePilot: recovery.scalePilot,
          scalePilotAmplitude: recovery.scalePilotAmplitude,
          edgeGuide: recovery.edgeGuide,
          edgeMarkers: recovery.edgeMarkers,
          edgeMarkerColumns: recovery.edgeMarkerColumns,
          ...diagnostic,
          repetitionRatio: recovery.repetitionRatio,
          copies: recovery.copies,
          parityBits: recovery.parityBits,
          framedBytes: recovery.framedBytes,
          riskAllocation: recovery.riskAllocation,
          corrections: recovery.corrections,
          decodedWidth: recovery.origWidth,
          decodedHeight: recovery.origHeight
        };
      } finally { textBytes.fill(0); }
    } catch (error) {
      if (error && error.code === "incorrect") return { status: "incorrect" };
      if (error && error.code === "frame") return { status: "none", failure: { stage: "payload", reason: error.message } };
      throw error;
    }
  }

  async function encodeAt(reference, width, height, payload, passwordProtected, strength, adaptive, bundle, carrierVersion, quality = DEFAULT_QUALITY, scalePilot = false, edgeGuide = false, brightnessCurve, luminanceCurve = true, edgeMarkers = true, rangeConditioning = true, colourWavelets = true, sourceCurve = "gentle") {
    strength = Math.max(1, Math.min(32, strength));
    const version = locatorProfile(carrierVersion) ? carrierVersion : CARRIER_V1;
    const edgeMarkerColumns = version === CARRIER_V6 ? edgeMarkers ? 4 : 0 : compactCarrier(version) ? 6 : 0;
    const conditioned = version !== CARRIER_V6 || rangeConditioning;
    const gentleCurve = version === CARRIER_V6 && conditioned && sourceCurve === "gentle";
    brightnessCurve = version === CARRIER_V6 ? conditioned ? gentleCurve ? undefined : normalizeBrightnessCurve(brightnessCurve) : 0 : undefined;
    luminanceCurve = version === CARRIER_V6 && conditioned && !gentleCurve && luminanceCurve;
    const map = locatorProfile(version) ? locatorBlockMap(width, height, Infinity, version, edgeMarkerColumns) : null;
    const probe = await packFrame(payload, 8, passwordProtected, bundle);
    const columns = Math.floor(width / BLOCK);
    const blockCount = map ? map.length : columns * Math.floor(height / BLOCK);
    let signalPolicy = null;
    if (adaptive || version === CARRIER_V4 || compactCarrier(version)) {
      const available = blockCount - carrierOverhead(version);
      const bitsPerByte = payloadCodeBits(available, probe.length, version);
      if (available <= 0 || bitsPerByte === 0) {
        throw new Error("The framed payload needs " + probe.length.toLocaleString("en-GB") + " bytes, but this image holds " +
          Math.max(0, Math.floor(available / 9)).toLocaleString("en-GB") + ". Use a larger picture, smaller files or a shorter recording.");
      }
      if (version === CARRIER_V4 || compactCarrier(version)) {
        signalPolicy = qualitySignalPolicy(v4SignalPolicy(available / (probe.length * bitsPerByte), strength, version), quality);
        signalPolicy.strength = Math.max(strength, signalPolicy.strength);
        strength = signalPolicy.strength;
      } else {
        const copies = Math.max(1, Math.floor(available / (probe.length * bitsPerByte)));
        const multiplier = copies >= 4 ? 1 : copies === 3 ? 1.5 : copies === 2 ? 2 : 4;
        strength = Math.min(32, Math.max(strength, roundHalfToEven(strength * multiplier)));
      }
    }
    const framed = await packFrame(payload, strength, passwordProtected, bundle);
    let signalSource = reference;
    if (compactCarrier(version)) {
      const headroom = conditioned ? sourceRangeHeadroom(strength, signalPolicy, scalePilot) : 0;
      // Adjust the source before painting any carrier. The range curve must
      // never be applied to completed wavelets: that would change their shape.
      const rangeCurve = version === CARRIER_V6 ? conditioned ? gentleCurve ? "sinusoidal" : luminanceCurve ? "luminance-v2" : "magnifier-3-16" : "linear" : "sinusoidal";
      signalSource = !conditioned ? reference.slice() : version === CARRIER_V6 && luminanceCurve
        ? await mapLuminanceRange(reference, headroom, rangeCurve, brightnessCurve)
        : mapRange(reference, headroom, rangeCurve, false, brightnessCurve);
      if (scalePilot) signalSource = applyScalePilot(signalSource, width);
      // Fit neutral payload amplitudes against the guided source, avoiding
      // clipping at dark/bright extrema.
      if (edgeGuide) signalSource = root.PixelStowEdgeGuide.apply(signalSource, width, height);
      signalPolicy = { ...signalPolicy, rangeHeadroom: headroom, rangeCurve, brightnessCurve,
        luminanceCurve: version === CARRIER_V6 && luminanceCurve, textureSource: reference, colourSource: reference, scalePilot, edgeGuide, edgeMarkers, edgeMarkerColumns,
        localFit: !conditioned, colourWavelets: version === CARRIER_V6 && colourWavelets };
    }
    let output = signalSource.slice();
    const written = await writeSignal(signalSource, output, width, height, framed, strength, version, map, signalPolicy);
    if (map) paintLocators(signalSource, output, width, height, strength, version, signalPolicy);
    const markersVerified = !compactCarrier(version) || verifyAndRepairCompactLocators(signalSource, output, width, height, version, signalPolicy);
    return {
      pixels: output,
      markersVerified,
      liftedCornerCells: signalPolicy?.liftedCornerCells || 0,
      strength,
      copies: written.copies,
      parityBits: written.parityBits,
      repetitionRatio: written.repetitionRatio,
      framedBytes: written.framedBytes,
      riskAllocation: written.riskAllocation,
      passwordProtected,
      carrierVersion: version,
      rangeHeadroom: signalPolicy?.rangeHeadroom || 0,
      rangeCurve: signalPolicy?.rangeCurve || "linear",
      brightnessCurve: signalPolicy?.brightnessCurve,
      luminanceCurve: Boolean(signalPolicy?.luminanceCurve),
      colourWavelets: Boolean(signalPolicy?.colourWavelets),
      scalePilot: Boolean(signalPolicy?.scalePilot),
      scalePilotAmplitude: signalPolicy?.scalePilot ? SCALE_PILOT.amplitude : 0,
      edgeGuide: Boolean(signalPolicy?.edgeGuide),
      edgeMarkers: compactCarrier(version) && edgeMarkers,
      edgeMarkerColumns,
      map
    };
  }

  async function encode(pixels, width, height, text, password, options = {}) {
    return encodePayload(pixels, width, height, { text, attachments: [] }, password, options);
  }

  async function encodePayload(pixels, width, height, content, password, options = {}) {
    const quality = encodingQuality(options.quality);
    if (options.edgeMarkers === false && preferredCarrier !== CARRIER_V6)
      throw new Error("Optional edge midpoint markers are supported only by version 6.");
    if (preferredCarrier === CARRIER_V6 && (options.scalePilot === true || options.edgeGuide === false))
      throw new Error("Version 6 uses the current edge guide; historical guide variants are not supported.");
    if (preferredCarrier === CARRIER_V6 && !root.PixelStowEdgeGuide?.apply)
      throw new Error("The version 6 guide script is missing. Reload the page before encoding.");
    if (options.edgeGuide === true && !root.PixelStowEdgeGuide?.apply)
      throw new Error("The edge guide script is missing. Reload the page before encoding.");
    const edgeGuide = options.scalePilot !== true && options.edgeGuide !== false && Boolean(root.PixelStowEdgeGuide?.apply);
    const { text = "", attachments = [] } = content;
    if (!text && !attachments.length) throw new Error("Enter a message or add an attachment to encode.");
    assertImage(pixels, width, height, MAX_PIXELS);
    // The UI supplies the original source's cached reference so sizing and the
    // writer use exactly the same bytes, even when encoding a resized source.
    // Other callers can request generation explicitly or supply those bytes.
    let toneProfile = null;
    if (preferredCarrier === CARRIER_V6 && options.toneReference !== false) {
      if (content.toneProfile !== undefined) toneProfile = content.toneProfile;
      else if (options.toneReference === true) toneProfile = createToneReference(pixels, width, height);
    }
    const bundle = attachments.length > 0 || Boolean(toneProfile);
    const plain = bundle ? packBundle(text, attachments, toneProfile) : strictUtf8(text);
    if (!bundle && (plain.length < 1 || plain.length > MAX_TEXT)) {
      throw new Error(plain.length < 1 ? "Enter a message or add an attachment to encode." : "The message is longer than 16 KiB.");
    }
    try {
      assertImage(pixels, width, height, MAX_PIXELS);
      await yieldNow();
      // Input protection is independent of the user's active recovery formats.
      // A locked/native older fingerprint must still never be encoded again.
      const existing = await inspect(pixels, width, height, { quickOnly: true, includeLegacy: true });
      if (existing.found) {
        throw new Error("This image already contains a fingerprint. Choose a picture that does not have one.");
      }
      const locked = typeof password === "string" && password.length > 0;
      const wantLocators = Boolean(locatorProfile(preferredCarrier));
      if (compactCarrier(preferredCarrier) && !locatorFits(width, height, preferredCarrier))
        throw new Error("This picture is too small for version " + preferredCarrier + " recovery markers. Use a larger picture or select an older encoding format explicitly.");
      const usedVersion = wantLocators && locatorFits(width, height, preferredCarrier) ? preferredCarrier : CARRIER_V1;
      const payload = locked ? await encryptEnvelope(plain, password, bundle) : plain.slice();
      try {
        const sourceCurve = options.sourceCurve || (options.brightnessCurve !== undefined || options.luminanceCurve !== undefined ? "adjustable" : "gentle");
        let encoded = await encodeAt(pixels, width, height, payload, locked, STRENGTHS[0], true, bundle, usedVersion, quality, options.scalePilot === true, edgeGuide, options.brightnessCurve, options.luminanceCurve !== false, options.edgeMarkers !== false, options.rangeConditioning !== false, options.colourWavelets !== false, sourceCurve);
        for (;;) {
          const recovery = encoded.markersVerified
            ? await readNative(encoded.pixels, width, height, usedVersion, encoded.strength, undefined, encoded.map) : null;
          if (encoded.markersVerified && recovery && !recovery.locatorOnly && recovery.carrierVersion === usedVersion &&
            recovery.rangeHeadroom === encoded.rangeHeadroom && recovery.rangeCurve === encoded.rangeCurve &&
            (usedVersion !== CARRIER_V6 || recovery.brightnessCurve === encoded.brightnessCurve && recovery.luminanceCurve === encoded.luminanceCurve && recovery.edgeMarkers === encoded.edgeMarkers) &&
            recovery.colourWavelets === encoded.colourWavelets &&
            recovery.bundle === bundle && recovery.passwordProtected === locked && bytesEqual(recovery.payload, payload)) {
            return {
              pixels: encoded.pixels,
              width,
              height,
              strength: encoded.strength,
              copies: encoded.copies,
              parityBits: encoded.parityBits,
              repetitionRatio: encoded.repetitionRatio,
              framedBytes: encoded.framedBytes,
              riskAllocation: recovery.riskAllocation,
              toneProfile: toneProfile?.slice() || null,
              passwordProtected: locked,
              carrierVersion: usedVersion,
              rangeHeadroom: encoded.rangeHeadroom,
              rangeCurve: encoded.rangeCurve,
              brightnessCurve: encoded.brightnessCurve,
              luminanceCurve: encoded.luminanceCurve,
              colourWavelets: encoded.colourWavelets,
              liftedCornerCells: encoded.liftedCornerCells,
              scalePilot: encoded.scalePilot,
              scalePilotAmplitude: encoded.scalePilotAmplitude,
              edgeGuide: encoded.edgeGuide,
              edgeMarkers: encoded.edgeMarkers,
              edgeMarkerColumns: encoded.edgeMarkerColumns,
              quality,
              locatorFallback: wantLocators && usedVersion === CARRIER_V1
            };
          }
          let next = 0;
          for (let i = 0; i < STRENGTHS.length; i++) {
            if (STRENGTHS[i] > encoded.strength) {
              next = STRENGTHS[i];
              break;
            }
          }
          if (next === 0) {
            if (!encoded.markersVerified) throw new Error("The four recovery markers could not be verified in this picture. Choose another source image.");
            throw new Error("The message could not be verified in this image. Try another picture or a shorter message.");
          }
          encoded = await encodeAt(pixels, width, height, payload, locked, next, false, bundle, usedVersion, quality, options.scalePilot === true, edgeGuide, options.brightnessCurve, options.luminanceCurve !== false, options.edgeMarkers !== false, options.rangeConditioning !== false, options.colourWavelets !== false, sourceCurve);
        }
      } finally { payload.fill(0); }
    } finally { plain.fill(0); }
  }

  function paeth(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonal = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
    if (upDistance <= diagonal) return up;
    return upLeft;
  }

  async function inflateZlib(compressed) {
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot read PNG files.");
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function pngFallback(message) {
    const error = new Error(message || "Unsupported PNG.");
    error.code = "png-fallback";
    return error;
  }

  async function decodePng(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8) throw new Error("Not a PNG.");
    for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) throw new Error("Not a PNG.");
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let sawHeader = false;
    let sawEnd = false;
    const parts = [];
    while (offset + 12 <= bytes.length) {
      const length = readU32be(bytes, offset);
      if (offset + 12 + length > bytes.length) throw new Error("Truncated PNG.");
      const typeStart = offset + 4;
      const type = String.fromCharCode(bytes[typeStart], bytes[typeStart + 1], bytes[typeStart + 2], bytes[typeStart + 3]);
      if (crc32(bytes, typeStart, 4 + length) !== readU32be(bytes, typeStart + 4 + length)) {
        throw new Error("PNG checksum failed.");
      }
      const data = bytes.subarray(typeStart + 4, typeStart + 4 + length);
      if (type === "IHDR") {
        if (sawHeader || data.length !== 13) throw new Error("Invalid PNG header.");
        width = readU32be(data, 0);
        height = readU32be(data, 4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[10] !== 0 || data[11] !== 0) throw pngFallback();
        interlace = data[12];
        sawHeader = true;
      } else if (type === "IDAT") {
        if (!sawHeader) throw new Error("Invalid PNG.");
        parts.push(data);
      } else if (type === "IEND") {
        sawEnd = true;
        break;
      } else if ((bytes[typeStart] & 32) === 0 && type !== "PLTE") {
        throw pngFallback();
      }
      offset = typeStart + 8 + length;
    }
    if (!sawHeader || parts.length === 0 || !sawEnd || width < 1 || height < 1) throw new Error("Incomplete PNG.");
    if (width * height > MAX_INPUT_PIXELS) throw new Error("This photo exceeds the 32 megapixel input limit.");
    if (interlace !== 0 || bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw pngFallback();
    let size = 0;
    for (let i = 0; i < parts.length; i++) size += parts[i].length;
    const compressed = new Uint8Array(size);
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
      compressed.set(parts[i], cursor);
      cursor += parts[i].length;
    }
    const channels = colorType === 6 ? 4 : 3;
    const rowSize = width * channels;
    const raw = await inflateZlib(compressed);
    if (raw.length !== height * (rowSize + 1)) throw new Error("Unexpected PNG image data.");
    const samples = new Uint8Array(height * rowSize);
    let source = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[source++];
      const dest = y * rowSize;
      const prior = dest - rowSize;
      for (let x = 0; x < rowSize; x++) {
        const left = x >= channels ? samples[dest + x - channels] : 0;
        const up = y > 0 ? samples[prior + x] : 0;
        const upLeft = y > 0 && x >= channels ? samples[prior + x - channels] : 0;
        const value = raw[source++];
        let decoded = value;
        if (filter === 1) decoded = value + left;
        else if (filter === 2) decoded = value + up;
        else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
        else if (filter === 4) decoded = value + paeth(left, up, upLeft);
        else if (filter !== 0) throw new Error("Unsupported PNG filter.");
        samples[dest + x] = decoded & 255;
      }
    }
    if (channels === 4) return { pixels: samples, width, height, exact: true };
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < samples.length; i += 3, j += 4) {
      pixels[j] = samples[i];
      pixels[j + 1] = samples[i + 1];
      pixels[j + 2] = samples[i + 2];
      pixels[j + 3] = 255;
    }
    return { pixels, width, height, exact: true };
  }

  async function deflateRaw(data) {
    if (typeof CompressionStream !== "function") return deflateStored(data);
    let compressor;
    try { compressor = new CompressionStream("deflate-raw"); }
    catch { return deflateStored(data); }
    const stream = new Blob([data]).stream().pipeThrough(compressor);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function deflateStored(data) {
    const chunks = [];
    for (let offset = 0; offset < data.length || offset === 0; offset += 65535) {
      const length = Math.min(65535, data.length - offset);
      const block = new Uint8Array(5 + Math.max(0, length));
      block[0] = offset + length >= data.length ? 1 : 0;
      block[1] = length & 255;
      block[2] = (length >> 8) & 255;
      const inverted = (~length) & 0xFFFF;
      block[3] = inverted & 255;
      block[4] = (inverted >> 8) & 255;
      if (length > 0) block.set(data.subarray(offset, offset + length), 5);
      chunks.push(block);
      if (data.length === 0) break;
    }
    let size = 0;
    for (let i = 0; i < chunks.length; i++) size += chunks[i].length;
    const out = new Uint8Array(size);
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], cursor);
      cursor += chunks[i].length;
    }
    return out;
  }

  function adler32(data) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < data.length; i++) {
      a += data[i];
      b += a;
      if ((i & 4095) === 4095) {
        a %= 65521;
        b %= 65521;
      }
    }
    a %= 65521;
    b %= 65521;
    return ((b << 16) | a) >>> 0;
  }

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    writeU32be(out, 0, data.length);
    out.set(type, 4);
    out.set(data, 8);
    writeU32be(out, 8 + data.length, crc32(out, 4, 4 + data.length));
    return out;
  }

  function writeU32be(buffer, offset, value) {
    buffer[offset] = (value >>> 24) & 255;
    buffer[offset + 1] = (value >>> 16) & 255;
    buffer[offset + 2] = (value >>> 8) & 255;
    buffer[offset + 3] = value & 255;
  }

  async function writePng(pixels, width, height) {
    assertImage(pixels, width, height);
    const stride = width * 4;
    const raw = new Uint8Array(height * (stride + 1));
    for (let y = 0; y < height; y++) {
      const dest = y * (stride + 1);
      raw[dest] = 0;
      raw.set(pixels.subarray(y * stride, y * stride + stride), dest + 1);
    }
    const compressed = await deflateRaw(raw);
    const zlib = new Uint8Array(2 + compressed.length + 4);
    zlib[0] = 0x78;
    zlib[1] = 0x9C;
    zlib.set(compressed, 2);
    writeU32be(zlib, zlib.length - 4, adler32(raw));
    const header = new Uint8Array(13);
    writeU32be(header, 0, width);
    writeU32be(header, 4, height);
    header[8] = 8;
    header[9] = 6;
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = chunk([73, 72, 68, 82], header);
    const idat = chunk([73, 68, 65, 84], zlib);
    const iend = chunk([73, 69, 78, 68], new Uint8Array(0));
    const png = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
    png.set(signature, 0);
    png.set(ihdr, signature.length);
    png.set(idat, signature.length + ihdr.length);
    png.set(iend, signature.length + ihdr.length + idat.length);
    return new Blob([png], { type: "image/png" });
  }

  async function writeJpeg(pixels, width, height) {
    assertImage(pixels, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const view = new Uint8ClampedArray(pixels.length);
    view.set(pixels);
    context.putImageData(new ImageData(view, width, height), 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("The JPEG could not be saved."));
      }, "image/jpeg", 0.92);
    });
    return blob;
  }

  async function decodeWithCanvas(file) {
    if (typeof createImageBitmap !== "function") throw new Error("Could not read that image. Use a PNG or JPEG.");
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > MAX_INPUT_PIXELS) throw new Error("This photo exceeds the 32 megapixel input limit.");
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = Math.min(bitmap.height, 256);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const pixels = new Uint8Array(bitmap.width * bitmap.height * 4);
      try {
        // Decode at 1:1 in strips. A camera photo need not fit in a giant canvas,
        // and no resizing is applied to the pixels used by the reader.
        for (let y = 0; y < bitmap.height; y += canvas.height) {
          const rows = Math.min(canvas.height, bitmap.height - y);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, y, bitmap.width, rows, 0, 0, bitmap.width, rows);
          pixels.set(context.getImageData(0, 0, bitmap.width, rows).data, y * bitmap.width * 4);
          await yieldNow();
        }
        return { pixels, width: bitmap.width, height: bitmap.height, exact: false };
      } finally { canvas.width = canvas.height = 0; }
    } finally {
      bitmap.close();
    }
  }

  function isPng(bytes) {
    return bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  }

  async function readImageFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isPng(bytes)) {
      try {
        return await decodePng(bytes);
      } catch (error) {
        if (!error || error.code !== "png-fallback") throw error;
      }
    }
    return decodeWithCanvas(file);
  }

  function clampRange(value, minimum, maximum) {
    if (value < minimum) return minimum;
    if (value > maximum) return maximum;
    return value;
  }

  function clampChannel(value) {
    const rounded = roundHalfToEven(value);
    if (rounded < 0) return 0;
    if (rounded > 255) return 255;
    return rounded;
  }

  async function forwardSample(source, sourceW, sourceH, pixels, width, height, fit, signal) {
    const out = pixels.slice();
    const inverse = fit.matrix ? root.PixelStowTransform.invert(fit.matrix) : null;
    const correction = fit.readResolution?.phaseCorrection;
    const photoInverse = correction ? root.PixelStowTransform.invert(fit.readResolution.photoMatrix) : null;
    const readInverse = correction ? root.PixelStowTransform.invert(fit.readImage.matrix) : null;
    const curvedInverse = correction?.kind === "spline" ? await root.PixelStowLattice.inverse(correction, signal) : null;
    for (let y = 0; y < height; y++) {
      if ((y & 15) === 15) { checkCancelled(signal); await yieldNow(); }
      const originY = inverse ? 0 : (y - fit.phaseY) / fit.scaleY;
      for (let x = 0; x < width; x++) {
        let point = inverse ? mappedPoint(inverse, x, y) : { x: (x - fit.phaseX) / fit.scaleX, y: originY };
        if (correction) {
          const observed = mappedPoint(photoInverse, x, y);
          let native = curvedInverse ? root.PixelStowLattice.inverseAt(curvedInverse, observed.x, observed.y) : observed;
          if (!curvedInverse) for (let iteration = 0; iteration < 3; iteration++) {
            const delta = photoPhaseAt(correction, native.x, native.y);
            native = { x: observed.x - delta.x, y: observed.y - delta.y };
          }
          point = mappedPoint(readInverse, native.x, native.y);
        }
        if (point.x < 0 || point.y < 0 || point.x > sourceW - 1 || point.y > sourceH - 1) continue;
        const sample = bilinearSample(source, sourceW, sourceH, point.x, point.y);
        const index = (x + y * width) * 4;
        out[index] = sample[0];
        out[index + 1] = sample[1];
        out[index + 2] = sample[2];
        out[index + 3] = pixels[index + 3];
      }
    }
    return out;
  }

  function removeCarrierGuides(pixels, cleaned, width, height, fit) {
    cleanLocators(pixels, width, height, cleaned, fit.carrierVersion, fit.edgeMarkerColumns, fit.colourWavelets);
    if (fit.edgeGuide) {
      if (!root.PixelStowEdgeGuide?.apply) throw new Error("The edge guide script is missing. Reload the page before extracting the source.");
      cleaned = root.PixelStowEdgeGuide.apply(cleaned, width, height, { inverse: true });
    }
    if (fit.scalePilot) cleaned = applyScalePilot(cleaned, width, true, fit.scalePilotAmplitude || LEGACY_SCALE_PILOT_AMPLITUDE);
    return cleaned;
  }

  async function undoSourceRange(pixels, width, height, fit, photographed, signal) {
    if (!fit.rangeHeadroom) return pixels;
    return fit.luminanceCurve
      ? restoreLuminanceRange(pixels, width, height, fit.rangeHeadroom, fit.rangeCurve, fit.brightnessCurve, photographed, signal)
      : photographed
        ? restorePhotoRange(pixels, width, height, fit.rangeHeadroom, fit.rangeCurve, signal, fit.brightnessCurve)
        : mapRange(pixels, fit.rangeHeadroom, fit.rangeCurve, true, fit.brightnessCurve);
  }

  async function extractCarrier(pixels, width, height, strength, options = {}) {
    checkCancelled(options.signal);
    if (options.background && canUseReaderWorker(options)) {
      const saved = visualMappings.get(pixels);
      // Preserve the verified photo transform without copying its cached working
      // raster. The disposable worker reconstructs it from the full input copy.
      const visual = saved ? { width, height, geometry: saved.geometry, carrierVersion: saved.carrierVersion,
        readResolution: saved.readResolution, unreadable: saved.unreadable } : undefined;
      return searchInWorker(pixels, width, height, { ...options, strength, visual }, "extract-carrier");
    }
    if (options.visual) visualMappings.set(pixels, options.visual);
    const fit = await recover(pixels, width, height, options);
    if (!fit || fit.locatorOnly || !locatorProfile(fit.carrierVersion)) return extractBlind(pixels, width, height, strength);
    const origW = fit.origWidth, origH = fit.origHeight;
    const identity = !fit.matrix && origW === width && origH === height && fit.phaseX === 0 && fit.phaseY === 0;
    let restored;
    if (fit.matrix) {
      const read = fit.readImage || { pixels, width, height, matrix: fit.matrix };
      restored = new Uint8Array(origW * origH * 4);
      for (let y = 0; y < origH; y++) {
        if ((y & 31) === 31) await yieldNow();
        for (let x = 0; x < origW; x++) {
          const point = mappedPoint(read.matrix, x, y);
          restored.set(bilinearSample(read.pixels, read.width, read.height, point.x, point.y), (x + y * origW) * 4);
        }
      }
    } else restored = identity
      ? pixels.slice()
      : await resampleReadSpace(pixels, width, height, origW, origH, fit.scaleX, fit.scaleY, fit.phaseX, fit.phaseY);
    const photographed = !identity;
    const payloadMap = locatorBlockMap(origW, origH, Infinity, fit.carrierVersion, fit.edgeMarkerColumns);
    let colourBlocks = null;
    if (fit.colourWavelets) {
      const layout = riskLayout(payloadMap, origW, origH);
      colourBlocks = new Uint8Array(Math.floor(origW / BLOCK) * Math.floor(origH / BLOCK));
      for (let slot = RISK_MAP_BLOCKS; slot < layout.order.length; slot++) colourBlocks[payloadMap[PREAMBLE_BLOCKS + layout.order[slot]]] = 1;
    }
    const peak = fit.carrierVersion === CARRIER_V4 || compactCarrier(fit.carrierVersion) ? V4_PAYLOAD_PEAK : fit.strength;
    let cleaned = await extractBlind(restored, origW, origH, fit.strength, payloadMap, peak,
      { separateChannels: photographed, colourBlocks, signal: options.signal });
    const preparedSource = cleaned;
    cleaned = removeCarrierGuides(restored, cleaned, origW, origH, fit);
    if (identity && fit.colourWavelets) {
      // The first pass supplies block colours only. Independent RGB projections
      // also contain genuine colour detail, so they must not be the final image.
      // Regenerate the writer's bounded integer chroma deltas from the estimated
      // original palette, while retaining the neutral reader's two coefficients.
      const colourSource = await undoSourceRange(cleaned, origW, origH, fit, false, options.signal);
      cleaned = await extractBlind(restored, origW, origH, fit.strength, payloadMap, peak,
        { colourBlocks, colourSource, preparedSource, localFit: !fit.rangeHeadroom, signal: options.signal });
      cleaned = removeCarrierGuides(restored, cleaned, origW, origH, fit);
    }
    // Encoding applies the range shoulder on the native grid before guides and
    // wavelets. Undo it here, on that same grid, after those signals are gone.
    cleaned = await undoSourceRange(cleaned, origW, origH, fit, photographed, options.signal);
    if (fit.carrierVersion === CARRIER_V6 && options.restoreColour !== false) {
      // The stored histogram is the final colour step. It runs after the range
      // inverse and still inside the native rectangle, before the picture is
      // placed back into the capture. Protected references arrive only after unlock.
      const toneProfile = fit.passwordProtected ? options.toneProfile : fit.bundle ? unpackBundle(fit.payload).toneProfile : null;
      if (toneProfile) cleaned = await restoreTone(cleaned, origW, origH, toneProfile, options.signal);
    }
    if (identity) return cleaned;
    return forwardSample(cleaned, origW, origH, pixels, width, height, fit, options.signal);
  }

  async function extractBlind(pixels, width, height, strength, map = null, peakStrength = strength, options = {}) {
    assertImage(pixels, width, height);
    strength = Math.max(1, Math.min(32, strength | 0));
    const neutralMaximum = Math.max(1, peakStrength / strength);
    const colourMaximum = Math.max(1, Math.ceil(peakStrength * (1 + COLOUR_WAVELET_TINT) + 3) / strength);
    const common = new Float64Array(16);
    const difference = new Float64Array(16);
    let mean = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = x + y * 4;
        const one = scaleWeight(strength, WAVELET[x - y + 3]);
        const zero = scaleWeight(strength, WAVELET[x + y]);
        common[i] = (one + zero) / 2;
        difference[i] = one - zero;
        mean += common[i] / 16;
      }
    }
    let commonEnergy = 0;
    let differenceEnergy = 0;
    for (let i = 0; i < 16; i++) {
      common[i] -= mean;
      commonEnergy += common[i] * common[i];
      differenceEnergy += difference[i] * difference[i];
    }
    if (commonEnergy === 0 || differenceEnergy === 0) {
      throw new Error("The source image could not be recovered.");
    }
    const carrier = pixels.slice();
    const columns = Math.floor(width / BLOCK);
    const rows = Math.floor(height / BLOCK);
    const included = map ? new Uint8Array(columns * rows) : null;
    if (included) for (const block of map) included[block] = 1;
    // Camera processing can give neutral payloads different carrier gain in
    // R/G/B. Keep channel-aware removal for photographed images.
    const channelCount = options.separateChannels || options.colourBlocks ? 3 : 1;
    const markers = new Float64Array(channelCount), bits = new Float64Array(channelCount);
    const nativeKernel = options.colourSource ? new Float64Array(16) : null;
    for (let row = 0; row < rows; row++) {
      if ((row & 15) === 15) { await yieldNow(); checkCancelled(options.signal); }
      for (let column = 0; column < columns; column++) {
        if (included && !included[column + row * columns]) continue;
        const coloured = options.colourBlocks?.[column + row * columns];
        const channels = options.separateChannels || coloured ? 3 : 1;
        const maximum = coloured ? colourMaximum : neutralMaximum;
        markers.fill(0); bits.fill(0);
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const pixel = (column * BLOCK + x + (row * BLOCK + y) * width) * 4;
            const k = x + y * 4;
            for (let c = 0; c < channels; c++) {
              const brightness = channels === 1 ? (pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3 : pixels[pixel + c];
              markers[c] += brightness * common[k];
              bits[c] += brightness * difference[k];
            }
          }
        }
        if (coloured && nativeKernel) {
          const marker = clampRange((markers[0] + markers[1] + markers[2]) / (3 * commonEnergy), 0, neutralMaximum);
          const bit = clampRange((bits[0] + bits[1] + bits[2]) / (3 * differenceEnergy), -neutralMaximum / 2, neutralMaximum / 2);
          for (let k = 0; k < 16; k++) nativeKernel[k] = marker * common[k] + bit * difference[k];
          // Use the same palette and gamut-fit code as the writer, including
          // its reduced-tint fallback. Never infer a separate RGB detail gain.
          const amplitude = Math.max(1, Math.round(strength * (marker + 2 * Math.abs(bit)) / 2));
          const tint = fitTintedWavelet(options.preparedSource, options.colourSource, width,
            column * BLOCK, row * BLOCK, bit > 0 ? 1 : 0, amplitude, options.localFit);
          const chroma = colourOffsets(nativeKernel, tint?.redTint || 0, tint?.blueTint || 0);
          for (let k = 0; k < 16; k++) {
            const pixel = (column * BLOCK + k % 4 + (row * BLOCK + Math.floor(k / 4)) * width) * 4;
            for (let c = 0; c < 3; c++) carrier[pixel + c] = clampChannel(pixels[pixel + c] - nativeKernel[k] - chroma[k * 3 + c]);
          }
          continue;
        }
        for (let c = 0; c < channels; c++) {
          markers[c] = clampRange(markers[c] / commonEnergy, 0, maximum);
          bits[c] = clampRange(bits[c] / differenceEnergy, -maximum / 2, maximum / 2);
        }
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const k = x + y * 4;
            const pixel = (column * BLOCK + x + (row * BLOCK + y) * width) * 4;
            for (let c = 0; c < 3; c++) {
              const channel = channels === 1 ? 0 : c;
              const delta = markers[channel] * common[k] + bits[channel] * difference[k];
              carrier[pixel + c] = clampChannel(pixels[pixel + c] - delta);
            }
            carrier[pixel + 3] = pixels[pixel + 3];
          }
        }
      }
    }
    return carrier;
  }

  root.PixelStow = {
    estimateBytes,
    estimatePayloadBytes,
    payloadSize,
    createToneReference,
    estimateRepetition,
    estimatePayloadFrame,
    repetitionForFrame,
    estimateSignalGain,
    getBrightnessCurveDefault,
    normalizeBrightnessCurve,
    payloadsEqual,
    inspect,
    inspectNativeFile,
    decode,
    encode,
    encodePayload,
    extractCarrier,
    findVisualTransform,
    scanMarkers,
    trackMarkers,
    scanScaleGuide,
    scanEdgeGuide,
    analyzeNativeMarkers,
    // Read-only lab helpers: predictions supply positions, never marker identity.
    getVisualMarkerLayout(marker) {
      const profile = locatorProfile(marker.carrierVersion);
      return profile && locatorLayout(marker.originalWidth, marker.originalHeight, marker.carrierVersion)?.map(patch =>
        ({ ...patch, patchWidth: profile.width, patchHeight: profile.height }));
    },
    readVisualMarker(pixels, width, height, proposal) {
      assertImage(pixels, width, height);
      if (!locatorProfile(proposal.carrierVersion)) return null;
      const read = readVisualLocator(pixels, width, height, proposal.matrix, proposal.id, proposal.carrierVersion);
      return read && read.originalWidth === proposal.originalWidth && read.originalHeight === proposal.originalHeight ? read : null;
    },
    readMarkerCandidates,
    describeReadFailure,
    clearVisualTransform(pixels) { visualMappings.delete(pixels); },
    setCarrierVersion(version) { preferredCarrier = [CARRIER_V1, ...RECOVERY_CARRIERS].includes(version) ? version : CARRIER_V6; },
    getCarrierVersion() { return preferredCarrier; },
    setLegacyRecovery(enabled) { legacyRecovery = enabled === true; },
    getLegacyRecovery() { return legacyRecovery; },
    getRecoveryVersions: recoveryVersions,
    getLimits() { return { inputPixels: MAX_INPUT_PIXELS, encodingPixels: MAX_PIXELS }; },
    readImageFile,
    decodePng,
    writePng,
    writeJpeg
  };
})(typeof window !== "undefined" ? window : self);
