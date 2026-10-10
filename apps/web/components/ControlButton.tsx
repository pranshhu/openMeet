'use client';

import { Icon, type IconName } from './Icon';

type Variant = 'default' | 'danger' | 'active' | 'record';

// A circular Google-Meet-style control-bar button. Icon-only with an
// accessible label exposed via aria-label + native tooltip. `text` adds a
// visible word beside the icon from sm up (phones stay icon-only); keep it
// inside `label` so the accessible name contains what is on screen.
export function ControlButton({
  icon,
  label,
  text,
  shortcut,
  onClick,
  variant = 'default',
  wide = false,
  disabled = false,
  badge = false,
}: {
  icon: IconName;
  label: string;
  text?: string;
  /** The key that presses this button; `Shortcuts` looks it up and the tooltip names it. */
  shortcut?: string;
  onClick?: () => void;
  variant?: Variant;
  wide?: boolean;
  disabled?: boolean;
  /** A small dot in the corner, e.g. unread chat. Put the count in `label` too. */
  badge?: boolean;
}) {
  const base =
    'relative inline-flex h-12 items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';
  const shape = text ? 'w-12 sm:w-auto sm:gap-2 sm:pl-4 sm:pr-5' : wide ? 'w-16' : 'w-12';
  // 'record' shares the default grey skin; only its icon turns red (below).
  const skin =
    variant === 'danger'
      ? 'bg-[#ea4335] text-white hover:bg-[#d33426]'
      : variant === 'active'
        ? 'bg-white text-[#202124] hover:bg-white/90'
        : 'bg-[#3c4043] text-white hover:bg-[#4a4d51]';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`${base} ${shape} ${skin}`}
    >
      {/* A grey button with a red dot, so Record never reads as a twin of the red Leave button. */}
      <Icon name={icon} size={22} className={variant === 'record' ? 'text-[#f28b82]' : ''} />
      {text && <span className="hidden text-sm font-medium sm:inline">{text}</span>}
      {badge && (
        <span
          data-testid="badge"
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-[#8ab4f8] ring-2 ring-[#202124]"
        />
      )}
    </button>
  );
}
