// THE 3D PALETTE. One set of materials for every viewport and every target.
//
// Neutral and warm, matching the page's paper-and-ink palette: a charcoal chassis, a sand-coloured
// load, a terracotta obstacle, mid-grey wheels, an off-white floor with a faint graphite grid, and
// the humanoid in a neutral warm stone. There is NO BLUE anywhere in a viewport — a saturated blue
// reads as "UI chrome" and competes with the one colour that has to mean something.
//
// Exactly one colour carries meaning: ALERT, the same warm red the page uses for every piece of
// failure evidence (--alert in styles.css). It is used for the contact ring and the callout and for
// nothing else. The baseline ghost is a translucent graphite, so "what should have happened" reads as
// absent rather than as a second subject.
export const COL = {
  chassis: 0x45413a,   // warm charcoal
  load: 0xd9c39a,      // sand
  obstacle: 0xb4643c,  // terracotta
  wheel: 0x8a8680,     // mid grey
  spoke: 0xd2cec7,     // pale graphite, so a turning wheel reads as turning
  body: 0xc4b49e,      // humanoid: neutral warm stone
  link: 0x6a655d,      // arm: graphite links (a box per MJCF geom, the mesh's own bounding box)
  pad: 0x33302b,       // arm: the two gripper finger pads, darker so the hand reads against the links
  table: 0xd6bf96,     // arm: the sand work surface the part starts on
  part: 0xb4643c,      // arm: the carried part, in the same warm accent as the cart's obstacle
  floor: 0xf2f0ec,     // off-white
  grid: 0xd7d3cc,      // faint graphite
  line: 0x9a948c,      // thin scene annotations (clearance marker, healthy-height plate)
  detail: 0x1d1b18,    // near-black details (the rangefinder site)
  ghost: 0x6e6a64,     // translucent graphite baseline
  alert: 0xb42318,     // the single warm red, reserved for failure evidence
  background: 0xf7f6f4,
} as const;

/** CSS hex for the legend swatches, so the page and the viewport never drift apart. */
export const hex = (c: number): string => "#" + c.toString(16).padStart(6, "0");
