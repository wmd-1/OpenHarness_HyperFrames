// RULE: motion is snap-and-hit, never slow ease-in-out for primary entrances.
// RULE: cards "punch in" — translate from -8/-8 offset with shadow growing
//       from 0 to var(--bf-shadow). Mirrors the hover lift-up signature.
// RULE: tilts are baked at rest; do NOT tween rotation during entry.
//       Tilt-then-pop reads as wobble; tilt-at-rest reads as deliberate.
// RULE: emphasis on chrome (label-pills, buttons) uses back.out(1.6) to
//       echo the hard-shadow "stamp" feel.
// RULE: never blur shadows during motion — toggle box-shadow values, do
//       not interpolate filter() or use shadow-blur tweens.

const EASE = {
  entry: "expo.out", // cards hit and stick — template uses 0.15s ease but punchier on video scale
  emphasis: "back.out(1.6)", // chrome pops (pills, buttons, stat cards) — echoes the brutalist stamp
  exit: "power2.in", // sharp exits — never linger
  drift: "sine.inOut", // ambient (dot-grid fade-in, tilt micro-sway) only
};

const DUR = {
  snap: 0.16, // chrome hover, label-pill in, button settle — mirrors template's 0.15s
  med: 0.42, // card entry, headline reveal
  slow: 0.9, // hero entry, close-frame reveal — the loudest moments
};
