# PixelStow V6 browser recovery snapshot

The codec, transform and markertracker JavaScript files are copied unchanged
from TileStormDataHosting commit `1167f24` (current V6 square/optional edge
midpoint targets). They ship with the game; no PixelStow website, server,
sibling checkout or TileStorm schema is required at runtime.

`import.html` and `import.js` are the game-owned UI adapter. They select V6
explicitly and disable legacy recovery. Only a successful checked V6 decode
crosses the same-origin iframe bridge, as a message plus opaque attachments.
Passwords stay inside the importer and are cleared after submission. They are
never put into URLs, Unity messages or diagnostics.

The four corner markers establish identity and geometry. The optional 4x4-cell
edge midpoint targets are diagnostic/future calibration guides; this reader
does not use them to establish lock or correct lens distortion. The separate
faint guide remains part of V6.

Photo acquisition uses the same browser engine as PixelStow. Native Unity file
imports use the independent C# core and Unity pixel adapter. Native Unity
camera/perspective recovery is not implemented.

When updating the snapshot, copy its worker dependencies together and record the
source revision here. Keep the histogram restoration baseline and brightness
default 0.125; do not reintroduce the parked gamma experiments.
