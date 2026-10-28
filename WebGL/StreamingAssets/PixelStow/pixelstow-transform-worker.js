// Copyright 2026 massivehadron.com ltd.

// Dedicated disposable worker; its input is a copy, never the UI's pixel buffer.
importScripts("./pixelstow-spectrum.js?v=20261015-no-pilot1", "./pixelstow-edge-guide.js?v=20261017-framed-scale1", "./pixelstow-transform.js?v=20261019-v6-native1", "./pixelstow.js?v=20261021-native-detail1");
importScripts("./pixelstow-lattice.js?v=20261013-marker-follow2");
self.onmessage = async ({ data }) => {
  try {
    const options = {
      mode: data.mode, worker: false, geometryOnly: true, forceSearch: data.forceSearch,
      includeLegacy: data.includeLegacy, carrierVersion: data.carrierVersion, nativeOnly: data.nativeOnly,
      corners: data.corners, deadline: data.deadline,
      reduction: data.reduction, maxMilliseconds: data.maxMilliseconds,
      minimumCoverage: data.minimumCoverage,
      seed: data.seed, scaleGuide: data.scaleGuide, calibration: data.calibration, calibratedOnly: data.calibratedOnly,
      seedDeadline: data.seedDeadline,
      camera: data.camera,
      searchState: data.searchState, stopOnHighConfidence: data.stopOnHighConfidence,
      resumeDiscovery: data.resumeDiscovery,
      earlyPayload: data.earlyPayload, refinementState: data.refinementState,
      contentSearch: data.contentSearch,
      diagnostic: data.diagnostic,
      tracks: data.tracks, edgeBand: data.edgeBand, ghostFrames: data.ghostFrames, discover: data.discover,
      search: data.search, mip: data.mip, mipConfirmed: data.mipConfirmed, mipLap: data.mipLap,
      onSignature: (signature) => self.postMessage({ signature }),
      onProgress: (progress) => self.postMessage({ progress })
    };
    let result;
    if (data.operation === "extract-carrier") {
      result = await self.PixelStow.extractCarrier(data.pixels, data.width, data.height, data.strength,
        { visual: data.visual, worker: false, includeLegacy: data.includeLegacy, carrierVersion: data.carrierVersion,
          toneProfile: data.toneProfile, restoreColour: data.restoreColour });
      self.postMessage({ result }, [result.buffer]);
      return;
    }
    if (data.operation === "edge-guide") result = await self.PixelStow.scanEdgeGuide(data.pixels, data.width, data.height, options);
    else if (data.operation === "scale-guide") result = await self.PixelStow.scanScaleGuide(data.pixels, data.width, data.height, options);
    else if (data.operation === "inspect") result = await self.PixelStow.inspect(data.pixels, data.width, data.height, { ...options, geometryOnly: false, automatic: true });
    else if (data.operation === "markers") result = await self.PixelStow.scanMarkers(data.pixels, data.width, data.height, options);
    else if (data.operation === "track") result = await self.PixelStow.trackMarkers(data.pixels, data.width, data.height, options);
    else if (data.operation === "read-candidates") result = await self.PixelStow.readMarkerCandidates(data.pixels, data.width, data.height, data.scan, options);
    else result = await self.PixelStow.findVisualTransform(data.pixels, data.width, data.height, options);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error?.message || "The visual transform search failed." });
  }
};
