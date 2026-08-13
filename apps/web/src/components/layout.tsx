/**
 * The layout pieces every page is built from.
 *
 * These exist to keep one set of class names in one place. The project's React guidelines are
 * explicit about it: if two elements share a style, the style belongs in a component. It is also
 * what keeps the console looking like the grayscale wireframes rather than like whatever each page
 * did on its own.
 *
 * The state components - {@link Loading}, {@link ErrorAlert}, {@link InfoAlert} - are here for a
 * requirement rather than for tidiness. FR-037 asks every operation to report its own state, and a
 * page that renders nothing while it waits, or swallows a refusal, is the failure that requirement
 * names.
 *
 * Author: John Grimes
 */

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
  /** A short label beside the title: an event's status, an account's standing. */
  readonly status?: string;
  readonly actions?: ReactNode;
}>) {
  return (
    <header className="page-header">
      <div>
        <h1>
          {title}
          {status === undefined ? null : <Tag>{status}</Tag>}
        </h1>
        {subtitle === undefined ? null : (
          <p className="page-subtitle">{subtitle}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="page-actions">{actions}</div>
      )}
    </header>
  );
}

/** A bordered region with a heading, as the wireframes' cards. */
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
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        {actions === undefined ? null : <div>{actions}</div>}
      </div>
      {description === undefined ? null : (
        <p className="panel-description">{description}</p>
      )}
      {children}
    </section>
  );
}

/** A capability tag, a kind, or a status. */
export function Tag({ children }: Readonly<{ readonly children: ReactNode }>) {
  return <span className="tag">{children}</span>;
}

/**
 * A tag that can be turned on and off.
 *
 * A real `button`, so it is reachable by keyboard: the wireframe's chips are controls, and a
 * `span` with a click handler is a control only for people using a mouse.
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
      className={pressed ? "tag tag-on" : "tag"}
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
    <p className="state state-pending" role="status">
      {label}…
    </p>
  );
}

/** A refusal, in the server's own words. */
export function ErrorAlert({
  message,
}: Readonly<{ readonly message: string }>) {
  return (
    <p className="state state-error" role="alert">
      {message}
    </p>
  );
}

/** Something that worked. */
export function InfoAlert({
  children,
}: Readonly<{ readonly children: ReactNode }>) {
  return (
    <p className="state state-ok" role="status">
      {children}
    </p>
  );
}

/** A table or a list with nothing in it, said rather than left blank. */
export function EmptyState({
  children,
}: Readonly<{ readonly children: ReactNode }>) {
  return <p className="state state-empty">{children}</p>;
}

/** One labelled value, as the wireframes' detail rows. */
export function DetailRow({
  label,
  children,
}: Readonly<{ readonly label: string; readonly children: ReactNode }>) {
  return (
    <div className="detail-row">
      <span className="detail-label">{label}</span>
      <div className="detail-value">{children}</div>
    </div>
  );
}
