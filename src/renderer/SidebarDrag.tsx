import { useCallback, useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform, type MotionValue } from "framer-motion";
import {
  DRAG_THRESHOLD_PX,
  SPRINGS,
  VelocityTracker,
  handoff,
  project,
  rubberband
} from "./motion";

/**
 * Direct-manipulation sidebar width.
 *
 * The resizer follows the pointer 1:1 for the whole gesture — no snapping to
 * centre, no animation that only runs once the mouse is released. On release
 * the resting width is chosen from where the flick was *going* (momentum
 * projection), not from where the pointer happened to let go, and the spring
 * inherits the release velocity so there is no seam between drag and settle.
 *
 * Past either bound the handle resists progressively instead of stopping dead,
 * then springs back.
 */

export const SIDEBAR_MIN = 196;
export const SIDEBAR_MAX = 380;
const COLLAPSED = 0;
const HANDLE_HIT = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function useSidebarWidth(preferred: number, collapsed: boolean, onCommit: (width: number) => void) {
  const width = useMotionValue(collapsed ? COLLAPSED : clamp(preferred, SIDEBAR_MIN, SIDEBAR_MAX));
  const dragging = useRef(false);
  const grabOrigin = useRef(0);
  const startWidth = useRef(0);
  const tracker = useRef(new VelocityTracker());
  const cancelAnimation = useRef<(() => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Never let a running animation be the source of truth: on a re-target we
  // start from whatever is on screen right now.
  useEffect(() => {
    cancelAnimation.current?.();
    const target = collapsed ? COLLAPSED : clamp(preferred, SIDEBAR_MIN, SIDEBAR_MAX);
    cancelAnimation.current = animate(width, target, SPRINGS.default).stop;
    return () => cancelAnimation.current?.();
  }, [collapsed, preferred, width]);

  const settle = useCallback(
    (velocity: number) => {
      const current = width.get();
      const bounds = [SIDEBAR_MIN, preferred, SIDEBAR_MAX];
      const next = handoff(current, velocity, bounds);
      const target = clamp(next, SIDEBAR_MIN, SIDEBAR_MAX);
      if (velocity > 40) onCommit(target);
      else onCommit(target);
      cancelAnimation.current?.();
      cancelAnimation.current = animate(width, target, { ...SPRINGS.drawer, velocity }).stop;
    },
    [onCommit, preferred, width]
  );

  const collapse = useCallback(() => {
    cancelAnimation.current?.();
    const velocity = -project(900);
    cancelAnimation.current = animate(width, COLLAPSED, { ...SPRINGS.drawer, velocity }).stop;
    onCommit(width.get() >= SIDEBAR_MIN ? preferred : preferred);
  }, [onCommit, preferred, width]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      cancelAnimation.current?.();
      dragging.current = true;
      grabOrigin.current = event.clientX;
      startWidth.current = width.get();
      tracker.current.reset(event.clientX);
      setIsDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const raw = startWidth.current + (event.clientX - grabOrigin.current);
      // Soft boundary. The further past the bound, the less the handle yields.
      const next =
        raw < SIDEBAR_MIN
          ? SIDEBAR_MIN + rubberband(raw - SIDEBAR_MIN, SIDEBAR_MAX)
          : raw > SIDEBAR_MAX
            ? SIDEBAR_MAX + rubberband(raw - SIDEBAR_MAX, SIDEBAR_MAX)
            : raw;
      width.set(next);
      tracker.current.push(event.clientX);
    },
    [width]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      settle(tracker.current.velocity());
    },
    [settle]
  );

  return { width, isDragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }, collapse };
}

/**
 * The 1px visual seam plus its invisible hit area. Hitting the target must not
 * require precision, so the strip is 14px wide and reveals a 1px accent only
 * while dragging or when keyboard-focused.
 */
export function SidebarResizer({
  width,
  visible,
  handlers,
  dragging,
  onCollapse,
  onExpand
}: {
  width: MotionValue<number>;
  visible: boolean;
  handlers: Record<string, unknown>;
  dragging: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const opacity = useTransform(width, (value) => (value > 4 ? 1 : 0));

  if (!visible) return null;

  return (
    <motion.div
      {...handlers}
      role="separator"
      aria-orientation="vertical"
      aria-label="調整側邊欄寬度"
      tabIndex={0}
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      style={{ opacity }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 12;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          animate(width, Math.max(SIDEBAR_MIN, width.get() - step), SPRINGS.snappy);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          animate(width, Math.min(SIDEBAR_MAX, width.get() + step), SPRINGS.snappy);
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (width.get() < SIDEBAR_MIN / 2) onExpand();
          else onCollapse();
        }
      }}
    >
      <span className={`sidebar-resizer-line ${dragging || hovered ? "hot" : ""}`} />
    </motion.div>
  );
}

export { HANDLE_HIT, DRAG_THRESHOLD_PX };
