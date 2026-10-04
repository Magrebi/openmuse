/**
 * The geometry behind a shared element transition.
 *
 * When a `TaskCard` is tapped it does not cross-fade into the detail sheet — it
 * *becomes* the sheet. That means the panel has to start life exactly where the
 * card was and travel to where the sheet belongs. This module owns that
 * arithmetic.
 *
 * It is deliberately pure. Measuring on the native side is asynchronous and can
 * return nothing at all (an element that scrolled off between the press and the
 * layout pass), so the rule "what do we do when there is no source rectangle"
 * is a real decision that has to be right, and it is the kind of decision that
 * can only be right if it is testable without a renderer.
 *
 * Reanimated's own `sharedTransitionTag` would have been the obvious way to do
 * this. It is not used, and `ui.tsx` explains why in full: in Reanimated 4 it
 * is experimental, native-stack-only, unsupported on web, and does not work
 * through a transparent modal on iOS. OpenMuse is a `Modal`-based app that also
 * ships to the web.
 */

/** A rectangle in window coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One frame of the transition, as deltas from the panel's settled position. */
export interface SharedFrame {
  /** Offset to apply to the panel's own x, in points. */
  readonly translateX: number;
  readonly translateY: number;
  /** Factor to apply to the panel's width, 1 being its settled width. */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly opacity: number;
}

/** The state of a transition with no source: a plain fade from the centre. */
export const restFrame = (): SharedFrame => ({
  translateX: 0,
  translateY: 24,
  scaleX: 0.96,
  scaleY: 0.96,
  opacity: 0,
});

const finite = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);

/**
 * True when a rectangle can be used as a transition source.
 *
 * A zero or negative width means the element was never laid out, and a
 * rectangle far outside the window means it was measured against a surface that
 * has since changed size. Either way the "start" frame would be nonsense and
 * the panel would visibly jump on the way in — worse than not animating at all.
 */
export const isUsableRect = (rect: Rect | null | undefined, window?: Rect): boolean => {
  if (!rect) return false;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return false;
  if (width <= 0 || height <= 0) return false;
  if (window) {
    // Generous: a long sheet legitimately extends past the viewport, and a
    // card in a scrolled list can sit well above it. Only a genuinely stale
    // measurement — one from a surface that no longer exists — is this far out.
    const margin = 4000;
    if (x < -margin || y < -margin || x > window.width + margin || y > window.height + margin)
      return false;
  }
  return true;
};

/**
 * The frame a transition *starts* at, expressed as offsets from where the panel
 * will finally be.
 *
 * The panel's settled size is the reference for both axes, so the transform is
 * exactly the inverse of the panel's final geometry. Scaling about the centre
 * rather than the top-left matters: a panel that grows from its top-left corner
 * reads as a new element appearing, while one that grows from its centre reads
 * as the thing you tapped getting bigger.
 */
export const frameFromSource = (source: Rect, panel: Rect): SharedFrame => {
  const safeSource: Rect = {
    x: finite(source.x),
    y: finite(source.y),
    width: Math.max(1, finite(source.width, 1)),
    height: Math.max(1, finite(source.height, 1)),
  };
  const panelWidth = Math.max(1, finite(panel.width, 1));
  const panelHeight = Math.max(1, finite(panel.height, 1));
  const sourceCenterX = safeSource.x + safeSource.width / 2;
  const sourceCenterY = safeSource.y + safeSource.height / 2;
  const panelCenterX = finite(panel.x) + panelWidth / 2;
  const panelCenterY = finite(panel.y) + panelHeight / 2;
  return {
    translateX: sourceCenterX - panelCenterX,
    translateY: sourceCenterY - panelCenterY,
    // Never grow past the settled size on the way in: an overshooting scale
    // would make the panel bulge out of the card it came from, which is the
    // opposite of "this became that".
    scaleX: Math.min(1, safeSource.width / panelWidth),
    scaleY: Math.min(1, safeSource.height / panelHeight),
    // The card is opaque, so fading in would show it doubling underneath the
    // panel for the whole length of the transition.
    opacity: 1,
  };
};

/**
 * Interpolate between the start frame and the settled panel.
 *
 * `progress` is 0 at the source and 1 at rest. Doing the interpolation here
 * rather than in the animation driver means a caller driving this from a gesture
 * gets exactly the same curve as one driving it from a spring.
 */
export const interpolateFrame = (
  from: SharedFrame,
  to: SharedFrame,
  progress: number,
): SharedFrame => {
  const t = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return {
    translateX: from.translateX + (to.translateX - from.translateX) * t,
    translateY: from.translateY + (to.translateY - from.translateY) * t,
    scaleX: from.scaleX + (to.scaleX - from.scaleX) * t,
    scaleY: from.scaleY + (to.scaleY - from.scaleY) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
  };
};

/** The settled frame: no offsets, full size, fully opaque. */
export const settledFrame = (): SharedFrame => ({
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
});

/**
 * Choose the frame a transition should start from.
 *
 * With no usable source the panel fades up from just below its own position —
 * the behaviour the app had before shared elements existed. Always returning a
 * valid frame, rather than `null`, means the caller never has to branch and the
 * degenerate path is impossible to get wrong later.
 */
export const startFrame = (
  source: Rect | null | undefined,
  panel: Rect,
  window?: Rect,
): SharedFrame =>
  isUsableRect(source, window) ? frameFromSource(source as Rect, panel) : restFrame();
