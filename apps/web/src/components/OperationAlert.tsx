import { AlertIcon, CheckCircleIcon } from "@primer/octicons-react";

import { operationMessage, operationTone } from "../lib/operation.ts";

import type { Operation, OperationTone } from "../lib/operation.ts";
import type { JSX } from "react";

/**
 * What the console is doing, said out loud.
 *
 * Every screen that starts an operation renders one of these for it, which is how
 * FR-037 is kept: pending is a spinner and a sentence, a failure is the cause in
 * words, and a success says so. It is a live region, so the sentence reaches a
 * screen reader without the focus having to move.
 *
 * @author John Grimes
 */

/** The alert class for each tone. */
const classForTone: Record<OperationTone, string> = {
  info: "alert-info",
  error: "alert-error",
  success: "alert-success",
};

/**
 * Renders an operation's state.
 *
 * @param props - the operation to report
 * @returns the alert, or nothing when there is nothing to report
 * @example
 * ```tsx
 * <OperationAlert operation={operation} />
 * ```
 */
export function OperationAlert({
  operation,
}: Readonly<{
  /** the operation to report */
  operation: Operation;
}>): JSX.Element | null {
  const message = operationMessage(operation);
  if (message === undefined) {
    return null;
  }
  const tone = operationTone(operation);
  return (
    <div
      role="alert"
      aria-live="polite"
      className={`alert alert-soft ${classForTone[tone]}`}
    >
      {tone === "info" ? (
        <span className="loading loading-spinner loading-sm" />
      ) : null}
      {tone === "error" ? <AlertIcon size={16} /> : null}
      {tone === "success" ? <CheckCircleIcon size={16} /> : null}
      <span>{message}</span>
    </div>
  );
}
