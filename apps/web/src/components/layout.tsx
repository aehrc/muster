/**
 * The layout pieces every page is built from.
 *
 * These exist to keep one set of class names in one place. The project's React guidelines are
 * explicit about it: if two elements share a style, the style belongs in a component. It is
 * also what keeps the console speaking daisyUI's vocabulary - cards, badges and alerts -
 * rather than whatever each page did on its own.
 *
 * The state components - {@link Loading}, {@link ErrorAlert}, {@link InfoAlert},
 * {@link EmptyState} - are here for a requirement rather than for tidiness. FR-037 asks every
 * operation to report its own state, and a page that renders nothing while it waits, or
 * swallows a refusal, is the failure that requirement names. Each pairs an icon whose shape
 * differs by state with the words themselves, so the state survives being read without colour
 * (FR-004), and each keeps its `role` so it survives being read without eyes.
 *
 * Author: John Grimes
 */

import { useId } from "react";

import { StatusIcon } from "./icons.js";

import type { ReactNode } from "react";

/** A page's heading, its subtitle and whatever acts on the whole page. */
export function PageHeader({
  title,
  subtitle,
  status,
  actions,
}: Readonly<{
  readonly title: string;
  readonly subtitle?: ReactNode;
  /**
   * A short label beside the title: an event's status, an account's standing.
   *
   * A node rather than a string, so a page can hand over a `StatusLabel` - which is what
   * FR-004 asks for, every one of these being a state somebody has to read.
   */
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
}>) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {title}
          {status === undefined ? null : <Tag>{status}</Tag>}
        </h1>
        {subtitle === undefined ? null : (
          <p className="text-base-content/70 mt-1 max-w-3xl text-sm">
            {subtitle}
          </p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/** A bordered region with a heading, as a daisyUI card. */
export function Panel({
  title,
  description,
  actions,
  children,
}: Readonly<{
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}>) {
  // Named by its own heading, which turns the section into a landmark a reader can jump to
  // and gives the end-to-end suite a handle that is not a class name (FR-008). The card is
  // painted by daisyUI; the naming is what must not change.
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="card bg-base-100 border-base-300 mb-4 border shadow-sm"
    >
      <div className="card-body gap-3 p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="card-title text-lg" id={headingId}>
            {title}
          </h2>
          {actions === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {description === undefined ? null : (
          <p className="text-base-content/70 text-sm">{description}</p>
        )}
        {children}
      </div>
    </section>
  );
}

/** A capability tag, a kind, or a status. */
export function Tag({ children }: Readonly<{ readonly children: ReactNode }>) {
  return <span className="badge badge-sm badge-outline">{children}</span>;
}

/**
 * A tag that can be turned on and off.
 *
 * A real `button`, so it is reachable by keyboard: the wireframe's chips are controls, and a
 * `span` with a click handler is a control only for people using a mouse. On and off differ
 * by fill as well as by colour, and `aria-pressed` says which it is regardless of either.
 */
export function TagToggle({
  label,
  pressed,
  onToggle,
}: Readonly<{
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}>) {
  return (
    <button
      type="button"
      className={`badge badge-sm cursor-pointer ${
        pressed ? "badge-primary font-semibold" : "badge-outline"
      }`}
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

/** What a page shows while it waits. */
export function Loading({ label }: Readonly<{ readonly label: string }>) {
  return (
    <div className="alert my-2" role="status">
      <StatusIcon state="pending" />
      <span>{label}…</span>
    </div>
  );
}

/**
 * A refusal, in the server's own words.
 *
 * `alert-soft` rather than the solid variant: the soft alert tints its background and paints
 * its text in the state's colour, which is the colour the icon is already drawn in. The solid
 * one inverts that, and an error-coloured icon on an error-coloured background is invisible.
 */
export function ErrorAlert({
  message,
}: Readonly<{ readonly message: string }>) {
  return (
    <div className="alert alert-error alert-soft my-2" role="alert">
      <StatusIcon state="bad" />
      <span className="break-words">{message}</span>
    </div>
  );
}

/** Something that worked. */
export function InfoAlert({
  children,
}: Readonly<{ readonly children: ReactNode }>) {
  return (
    <div className="alert alert-success alert-soft my-2" role="status">
      <StatusIcon state="ok" />
      <span className="break-words">{children}</span>
    </div>
  );
}

/** A table or a list with nothing in it, said rather than left blank. */
export function EmptyState({
  children,
}: Readonly<{ readonly children: ReactNode }>) {
  return (
    <div className="alert my-2">
      <StatusIcon state="none" />
      <span>{children}</span>
    </div>
  );
}

/** One labelled value, as the wireframes' detail rows. */
export function DetailRow({
  label,
  children,
}: Readonly<{ readonly label: string; readonly children: ReactNode }>) {
  return (
    <div className="border-base-300 flex flex-col gap-1 border-b py-2 text-sm last:border-b-0 sm:flex-row sm:gap-4">
      <span className="text-base-content/60 sm:w-52 sm:shrink-0">{label}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
