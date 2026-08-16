/**
 * What every state looks like.
 *
 * One module, because the alternative is each page choosing its own mark and the console
 * ending up with two shapes for "this failed". FR-004 is the reason it matters: a state has
 * to be readable without reading its colour, so the shape carries the difference and the
 * theme's colour only reinforces it. No two states in {@link StatusState} share an icon.
 *
 * Every icon here is decorative. It is `aria-hidden`, and it never appears without the words
 * beside it (FR-005): a reader using a screen reader gets the text, and a reader who cannot
 * tell red from green gets the shape.
 *
 * The states themselves - and the domain records mapping a coverage outcome or a pairing
 * state onto one - are in `./statusStates.ts`, so that this file exports components and
 * nothing else.
 *
 * Pure: no I/O, no state, no clock.
 *
 * Author: John Grimes
 */

import {
  AlertIcon,
  CheckCircleIcon,
  CircleSlashIcon,
  ClockIcon,
  DashIcon,
  HourglassIcon,
  InfoIcon,
  QuestionIcon,
  XCircleIcon,
} from "@primer/octicons-react";

import type { StatusState } from "./statusStates.js";
import type { Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";

/** One state, one shape. Nine states, nine distinct Octicons (FR-004). */
const STATE_ICONS: Readonly<Record<StatusState, Icon>> = {
  ok: CheckCircleIcon,
  bad: XCircleIcon,
  warning: AlertIcon,
  unknown: QuestionIcon,
  blocked: CircleSlashIcon,
  expired: ClockIcon,
  pending: HourglassIcon,
  none: DashIcon,
  info: InfoIcon,
};

/**
 * The theme colour each state is drawn in.
 *
 * Reinforcement rather than information: everything these say is already said by the shape
 * and by the words. Both themes define these tokens, so the colours follow the system
 * preference with the rest of the console.
 */
const STATE_COLOURS: Readonly<Record<StatusState, string>> = {
  ok: "text-success",
  bad: "text-error",
  warning: "text-warning",
  unknown: "text-info",
  blocked: "text-error",
  expired: "text-base-content/60",
  pending: "text-base-content/60",
  none: "text-base-content/50",
  info: "text-info",
};

/**
 * One state's mark.
 *
 * Decorative by definition: it is `aria-hidden`, so it must never be the only thing saying
 * what the state is. Use {@link StatusLabel} unless the words are already beside it.
 */
export function StatusIcon({
  state,
  size = 16,
  className = "",
}: Readonly<{
  readonly state: StatusState;
  /** In pixels, matching the surrounding text. */
  readonly size?: number;
  readonly className?: string;
}>) {
  const Glyph = STATE_ICONS[state];
  return (
    <Glyph
      aria-hidden
      className={`shrink-0 ${STATE_COLOURS[state]} ${className}`.trim()}
      size={size}
    />
  );
}

/**
 * A state's mark and the words that carry it (FR-004, FR-005).
 *
 * The pairing is the point: the shape differs by state, the text says which state it is, and
 * the colour only agrees with both. Nothing here is legible by colour alone, and nothing is
 * legible by icon alone.
 */
export function StatusLabel({
  state,
  children,
  className = "",
}: Readonly<{
  readonly state: StatusState;
  readonly children: ReactNode;
  readonly className?: string;
}>) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`.trim()}>
      <span className="translate-y-0.5 self-start">
        <StatusIcon state={state} />
      </span>
      <span>{children}</span>
    </span>
  );
}
