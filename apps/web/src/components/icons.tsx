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
 * The domain records - {@link COVERAGE_STATES}, {@link PAIRING_STATE_STATES} and the rest -
 * are the whole of the state vocabulary in one greppable place, so a page renders a coverage
 * outcome or a pairing state by looking it up rather than by deciding again. They are records
 * rather than functions on purpose: a lookup that cannot branch cannot drift.
 *
 * Pure: no I/O, no state, no clock.
 *
 * Author: John Grimes
 */

/*
 * The state vocabulary and the components that draw it are one thing, and splitting them
 * across two files to satisfy a hot-reload heuristic would cost a module and buy an editor
 * nicety: this file exports the records deliberately, so editing it reloads the page rather
 * than patching it.
 */
/* eslint-disable react-refresh/only-export-components */

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

import type {
  AccountStatus,
  DcrRunOutcome,
  DcrRunStep,
  EventStatus,
  HarnessCheckOutcome,
  PairingState,
  PersonaCoverageOutcome,
  PersonaSourceStatus,
} from "@muster/contracts";
import type { Icon } from "@primer/octicons-react";
import type { ReactNode } from "react";

/**
 * The console's states, as shapes.
 *
 * Deliberately semantic rather than domain-specific: a persona that was not found and a check
 * that failed are the same shape because they are the same claim - "we asked, and the answer
 * was no". The distinctions that matter are the ones a reader would otherwise misread, and
 * each of them gets its own entry: `unknown` is not `bad` (FR-032 - "we could not tell" is
 * not "it is not there"), `blocked` is not `bad` (somebody refused, rather than something
 * broke), and `none` is not `pending` (nothing has been asked, rather than an answer being
 * awaited).
 */
export const STATUS_STATES = [
  "ok",
  "bad",
  "warning",
  "unknown",
  "blocked",
  "expired",
  "pending",
  "none",
  "info",
] as const;

/** One of the console's states. */
export type StatusState = (typeof STATUS_STATES)[number];

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

/** A verification check's confidence, as `describeCheckStatus` reports it (FR-017). */
export const CHECK_TONE_STATES: Readonly<
  Record<"unknown" | "ok" | "bad", StatusState>
> = {
  ok: "ok",
  bad: "bad",
  // Nobody has looked yet, which is an absence rather than an unanswered question.
  unknown: "none",
};

/** One conformance check's outcome, and a run's verdict: they share a vocabulary. */
export const HARNESS_OUTCOME_STATES: Readonly<
  Record<HarnessCheckOutcome, StatusState>
> = {
  passed: "ok",
  failed: "bad",
};

/** The harness verdict banner's tone, as `describeVerdict` reports it (FR-030). */
export const VERDICT_TONE_STATES: Readonly<
  Record<"pass" | "fail" | "none", StatusState>
> = {
  pass: "ok",
  fail: "bad",
  none: "none",
};

/**
 * Whether a server holds a persona (FR-032).
 *
 * `unchecked` is the key for a pair nothing has looked at, matching the `data-state` the
 * coverage grid already carries. `unverifiable` is a question mark and not a cross, which is
 * the distinction the requirement exists for.
 */
export const COVERAGE_STATES: Readonly<
  Record<PersonaCoverageOutcome | "unchecked", StatusState>
> = {
  found: "ok",
  missing: "bad",
  unverifiable: "unknown",
  unchecked: "none",
};

/** Whether a curated persona is still on the source server. */
export const PERSONA_SOURCE_STATES: Readonly<
  Record<PersonaSourceStatus, StatusState>
> = {
  present: "ok",
  missing: "bad",
};

/**
 * How one step of a trusted-DCR run reads.
 *
 * `running` and `waiting` are the console's own additions, matching the `data-state` the step
 * list already carries: before a run the steps are waiting, and during one the step that has
 * not reported yet is running.
 */
export const DCR_STEP_STATES: Readonly<
  Record<DcrRunStep["outcome"] | "running" | "waiting", StatusState>
> = {
  done: "ok",
  failed: "bad",
  skipped: "blocked",
  running: "pending",
  waiting: "none",
};

/**
 * How a trusted-DCR run ended.
 *
 * `refused` and `unreachable` get different shapes for the reason the contract keeps them
 * apart: the server disagreeing with the statement and the endpoint not answering are
 * different people's problems.
 */
export const DCR_RUN_OUTCOME_STATES: Readonly<
  Record<DcrRunOutcome, StatusState>
> = {
  registered: "ok",
  refused: "blocked",
  unreachable: "warning",
};

/** Where a pairing has got to (FR-013). Five states, five shapes. */
export const PAIRING_STATE_STATES: Readonly<Record<PairingState, StatusState>> =
  {
    requested: "pending",
    fulfilled: "ok",
    // Somebody said no, which is not the same as something breaking.
    declined: "blocked",
    failed: "bad",
    // The event closed with the request outstanding.
    lapsed: "expired",
  };

/** An account's standing: pending until an admin approves it, revocable after. */
export const ACCOUNT_STATUS_STATES: Readonly<
  Record<AccountStatus, StatusState>
> = {
  pending: "pending",
  approved: "ok",
  revoked: "blocked",
};

/** An event's lifecycle position. */
export const EVENT_STATUS_STATES: Readonly<Record<EventStatus, StatusState>> = {
  draft: "none",
  open: "ok",
  closed: "expired",
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
