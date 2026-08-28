# Klase UI Style Guide

Starting direction for the **2D UI/UX layer only**. Hex values and radii below are drafts — open to refinement once mockups exist.

Product context: [project-spec.md](./project-spec.md).

## What this covers

Menus, buttons, chat panels, avatar customization **chrome**, HUD overlays, login/landing pages.

## What this does not cover

The Three.js classroom, furniture, lighting, and avatar meshes. Those follow the spec’s separate art direction (procedural rounded humanoids, coded wearables). Do not apply these CSS tokens as Three.js materials.

---

## Claymorphism recipe

Volume comes from stacked soft shadows and inner highlights, not hard 1px borders.

- **Corners:** ~24–32px on large panels; ~16–20px on buttons; ~12–16px on compact HUD chips.
- **Light:** highlight from top-left (near-white, low opacity); cooler dusty-blue shadow down-right.
- **Feel:** inflated / puffy. Not glass (avoid heavy backdrop-blur as the look) and not flat gray neumorphism.
- **Edges:** skip a hard stroke as the primary outline. A faint periwinkle tint is fine if a control needs extra definition.
- **Press:** invert highlight and shadow so the control looks pushed into the clay.
- **Focus:** a soft periwinkle glow, not a black ring.

Example elevation (starting, not locked):

```css
.klase-clay {
  border-radius: 24px;
  border: none;
  background: var(--klase-surface);
  box-shadow:
    8px 10px 24px rgba(107, 115, 153, 0.22),
    -4px -5px 16px rgba(255, 255, 255, 0.85),
    inset 2px 3px 6px rgba(255, 255, 255, 0.7),
    inset -3px -4px 8px rgba(168, 176, 208, 0.35);
}
```

---

## Starting tokens (unlocked)

When the app is scaffolded, move these into something like `src/styles/tokens.css`.

```css
:root {
  /* Base wash — pale baby blue / dusty periwinkle */
  --klase-periwinkle-50: #eef1f8;
  --klase-periwinkle-100: #e4e8f4;
  --klase-periwinkle-200: #c9d0e8;
  --klase-periwinkle-400: #a8b0d0;
  --klase-periwinkle-600: #6b7399;

  /* Surfaces */
  --klase-cream: #fbf8f3;
  --klase-white: #ffffff;
  --klase-surface: #f7f6fb;
  --klase-page: var(--klase-periwinkle-100);

  /* Ink — soft slate-violet, not pure black */
  --klase-ink: #3d425c;
  --klase-ink-muted: #6b7399;

  /* Sparse pastel accents (states, badges — not every panel) */
  --klase-lavender: #d4c8e8;
  --klase-mint: #c8e6d4;
  --klase-peach: #f3d4c8;
  --klase-butter: #f3e8c8;

  --klase-radius-hud: 14px;
  --klase-radius-control: 18px;
  --klase-radius-panel: 28px;
}
```

**How to use color**

- Page / full 2D screens: periwinkle wash.
- Raised clay: cream or off-white surface.
- Mid clay (secondary wells, chat input): `--klase-periwinkle-200`.
- Text: `--klase-ink` / `--klase-ink-muted`.
- Accents: lavender (owner), mint (success / unmute), peach (warn / kick confirm), butter (admin) — one accent per badge, not a rainbow chrome.

---

## Screen mapping

| Surface | How claymorphism shows up |
|---|---|
| Landing / login | Full 2D page. Puffy card on periwinkle wash. Cream fields. One clay primary CTA. |
| HUD | Compact clay chips over the 3D canvas. Keep them small so they do not fight the room. Slightly more opaque than a glass HUD. |
| Menus / player list | Rounded clay sheets. Role badges use pastel accents. Destructive actions stay peach, not neon red. |
| Chat panels | Puffy message well. Incoming vs outgoing via cream vs periwinkle tint, not harsh contrast. |
| Avatar customization | 2D clay chrome around the 3D preview: tabs, wearable tiles, save CTA. The avatar viewport itself is not restyled. |
| Rooms-full / errors | Same clay card language as login; peach accent for the alert, not a flat red banner. |

---

## Do / don’t

**Do**

- Keep HUD compact; clay is for overlay chrome, not a thick frame around the world.
- Use pastel accents for role chips and states only.
- Match pressed / disabled states with shadow inversion and lower contrast, not gray-out to #999.

**Don’t**

- Neon, sharp black drop shadows, skeuomorphic wood/metal.
- Glassmorphism as the default (heavy blur + thin stroke).
- Apply this palette or extrusion to classroom meshes or avatars.
- Treat this file as a locked brand book until mockups are explored.

---

## Implementation

Overlay tokens live in [`client/src/styles.css`](../client/src/styles.css) and are used only by DOM chrome (landing, HUD, chat, menus). Three.js materials do not import these variables.
