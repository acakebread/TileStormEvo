# PixelStow V6 browser recovery snapshot

The codec, transform and markertracker JavaScript files are copied unchanged
from TileStormDataHosting commit `28657b8` (V6 gentle source conditioning,
native colour-detail recovery, square/optional edge midpoint targets,
shared original-colour targets and matched marker backgrounds). They ship with the game; no PixelStow website, server,
sibling checkout or TileStorm schema is required at runtime.

The accepted utility correction retains the original sinusoidal brightness
shoulder as the default, with adjustable brightness/hue available explicitly.
Native source recovery regenerates colour deltas using the shared writer
calculation. These source-viewer/encoding controls are not part of the game importer.
The C# reader accepts both the existing adjustable codes 0..248 and gentle code
249; it retains the direct-artwork profile used by game cards.

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
imports use the independent C# core and Unity pixel adapter. Editor play mode
and native builds also have a Unity WebCamTexture capture panel, with guided
four-corner photo recovery in C#. That native path does not execute these
browser scripts or implement their automatic marker acquisition.

When updating the snapshot, copy its worker dependencies together and record the
source revision here. Keep the histogram restoration baseline and gentle
default for source-conditioned utility images; adjustable mode retains its
0.125 brightness/hue controls. Do not reintroduce the
parked gamma experiments. Game cards set RangeConditioning=false and
ColourWavelets=true. Their tones are preserved except for local signal-fitting
adjustments. Media cards contain no histogram reference and omit optional edge
midpoint targets; the four corner markers remain required. The histogram and
edge midpoint settings do not select appearance.

This accepted V6 layout is now the compatibility baseline. Future incompatible
encoding changes must use V7 and retain V6 reading, rather than reinterpret V6
headers or require existing level images to be re-encoded. See
`Docs/PixelStowImageInteroperability.md` for the preservation policy.
