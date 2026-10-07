/**
 * Keeps the page at 1× on phones, and makes sure it can always get back there.
 *
 * iOS Safari ignores `user-scalable=no`, and double-tap zoom can still fire on quick taps of a
 * button (the touch lands on its icon, which does not carry the button's touch-action). The app
 * blocks pinch-zoom (the sky handles its own pinch), so a page zoomed by accident would be stuck.
 */
export function guardPageZoom() {
  const viewport = window.visualViewport;
  const zoomed = () => (viewport ? viewport.scale > 1.02 : false);

  // 1. Quick second taps: swallow the touch (no double-tap zoom) and deliver its click ourselves,
  //    so tapping + three times fast still means three steps.
  let lastTapEnd = -Infinity;
  document.addEventListener(
    'touchend',
    (event) => {
      const now = event.timeStamp;
      const quick = now - lastTapEnd < 400;
      lastTapEnd = now;
      if (!quick || event.touches.length > 0 || event.changedTouches.length !== 1) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      // Text fields, sliders and selects keep their native behaviour; the sky has touch-action none.
      if (!target || target.closest('input:not([type="checkbox"]), select, textarea, canvas')) {
        return;
      }
      event.preventDefault();
      const control = target.closest<HTMLElement>('button, summary, label, [role="button"]');
      control?.click();
    },
    { passive: false }
  );

  // iOS Safari's own pinch gesture: blocked, except while zoomed in, so a pinch can undo it.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(
      type,
      (event) => {
        if (!zoomed()) {
          event.preventDefault();
        }
      },
      { passive: false }
    );
  }

  // 2. If the page is zoomed anyway (or Safari restored a zoomed page on reload): ask the viewport
  //    tag to reset it, and meanwhile allow pinching everywhere so the user can zoom back out.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const original = meta?.content ?? '';
  const check = () => {
    const isZoomed = zoomed();
    document.documentElement.classList.toggle('page-zoomed', isZoomed);
    if (isZoomed && meta) {
      // Rewriting the tag makes Safari re-apply its scale limits.
      meta.content = `${original}, minimum-scale=1`;
      requestAnimationFrame(() => {
        meta.content = original;
      });
    }
  };
  viewport?.addEventListener('resize', check);
  window.addEventListener('pageshow', check);
  check();
}
