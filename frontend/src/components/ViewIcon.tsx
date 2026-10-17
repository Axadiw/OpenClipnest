import type { EventView } from '../types';

/**
 * Centralized SVG glyph dispatch for camera view toggle buttons.
 *
 * Previously this ternary was duplicated inline in VideoPlayer, EventCard, and
 * TimelineView. Each glyph is a 24×24 stroke-only line icon (`stroke="currentColor"`,
 * `fill="none"`) so it inherits the button's text color. `generic` — and any
 * unknown/missing kind — renders a plain camera glyph.
 */

export type IconKind = NonNullable<EventView['iconKind']>;

/** Palette order shown in the per-view icon picker. */
export const VIEW_ICON_KINDS: IconKind[] = [
  'wide',
  'zoom',
  'fisheye',
  'tele',
  'ptz',
  'doorbell',
  'thermal',
  'generic',
];

interface ViewIconProps {
  kind?: EventView['iconKind'];
  /** Square px size for width+height. Defaults to 16. */
  size?: number;
}

export function ViewIcon({ kind, size = 16 }: ViewIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
  } as const;

  switch (kind) {
    case 'wide':
      // Trapezoid opening downward — wide field of view.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 6 L12 20 L22 6" /><line x1="2" y1="6" x2="22" y2="6" />
        </svg>
      );
    case 'zoom':
      // Narrow triangle — telephoto / zoomed-in field of view.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 4 L12 20 L16 4" /><line x1="8" y1="4" x2="16" y2="4" />
        </svg>
      );
    case 'fisheye':
      // Concentric circles — 360°/fisheye lens.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'tele':
      // Long-lens barrel with focus rings — telephoto / long lens.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="9" width="16" height="6" rx="1" />
          <line x1="9" y1="9" x2="9" y2="15" />
          <line x1="14" y1="9" x2="14" y2="15" />
        </svg>
      );
    case 'ptz':
      // Circular arrows — pan/tilt/zoom motorized camera.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 12a8 8 0 1 1-3-6.2" />
          <polyline points="20 4 20 8 16 8" />
        </svg>
      );
    case 'doorbell':
      // Bell with clapper — video doorbell.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 16H6a2 2 0 0 0 1-1.7V11a5 5 0 0 1 10 0v3.3A2 2 0 0 0 18 16z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'thermal':
      // Heat waves — thermal imaging camera.
      return (
        <svg {...common} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 16c1.5-2 1.5-4 0-6s-1.5-4 0-6" />
          <path d="M12 16c1.5-2 1.5-4 0-6s-1.5-4 0-6" />
          <path d="M19 16c1.5-2 1.5-4 0-6s-1.5-4 0-6" />
        </svg>
      );
    default:
      // generic + any unknown kind — plain camera body.
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13" r="3" />
        </svg>
      );
  }
}
