import { failed as failedOperation, succeeded } from "./operation.ts";
import { mayTake } from "./pairings.ts";

import type { Operation } from "./operation.ts";
import type { Detail } from "./systemDetails.ts";
import type {
  DcrRunResponse,
  DcrStepOutcome,
  PairingSummary,
  StatementClaims,
} from "@muster/contracts";

/**
 * What the registration screen decides before it renders anything.
 *
 * Whether to offer the run is asked of the shared state machine rather than
 * restated here, so the console cannot offer a button the server would refuse or
 * withhold one it would allow.
 *
 * How to report a finished run is the other half. A run whose server refused the
 * statement is a failure, even though the HTTP request that carried it succeeded:
 * the operation the member started was "register this client at that server", and
 * that is the thing that must report pending, failed with cause, or succeeded
 * (FR-037).
 *
 * @author John Grimes
 */

/** How the console colours each step's outcome. */
const stepClasses: Record<DcrStepOutcome, string> = {
  succeeded: "text-success",
  failed: "text-error",
  skipped: "text-base-content/50",
};

/**
 * Whether the reader may run a trusted registration on a pairing.
 *
 * Two states qualify, and both are the state machine's answer rather than this
 * module's: a request can be registered, and a failed attempt can be retried -
 * which the server does by retrying the pairing and presenting a fresh statement.
 *
 * @param pairing - the pairing as the console received it
 * @returns true when a run would be accepted
 * @example
 * ```tsx
 * {mayRegister(pairing) ? <Link to={`/pairings/${pairing.id}/register`} /> : null}
 * ```
 */
export const mayRegister = (pairing: PairingSummary): boolean =>
  mayTake(pairing, "register") || mayTake(pairing, "retry");

/**
 * The class that colours one step's outcome.
 *
 * @param outcome - how the step turned out
 * @returns the class to render it with
 * @example
 * ```tsx
 * <span className={stepClass(step.outcome)}>{step.name}</span>
 * ```
 */
export const stepClass = (outcome: DcrStepOutcome): string =>
  stepClasses[outcome];

/**
 * Says how a finished run turned out.
 *
 * @param run - the run as the server reported it
 * @returns a sentence fit to show the member who started it
 * @example
 * ```ts
 * setMessage(describeRun(result.data));
 * ```
 */
export const describeRun = (run: DcrRunResponse): string => {
  if (run.serverError === null && run.clientId !== null) {
    return `${run.pairing.server.systemName} registered ${run.pairing.client.systemName} as ${run.clientId}.`;
  }
  const error = run.serverError;
  const said = [
    `${run.pairing.server.systemName} refused the registration: `,
    error === null ? "no reason given" : error.error,
    error?.errorDescription === undefined ? "" : ` - ${error.errorDescription}`,
  ].join("");
  // The server's own description often ends in a full stop of its own, and two
  // in a row reads like a typing error rather than a quotation.
  return said.endsWith(".") ? said : `${said}.`;
};

/**
 * Turns a finished run into the operation state the screen reports.
 *
 * @param run - the run as the server reported it
 * @returns the operation to render
 * @example
 * ```ts
 * setOperation(runOperation(result.data));
 * ```
 */
export const runOperation = (run: DcrRunResponse): Operation =>
  run.serverError === null && run.clientId !== null
    ? succeeded("Registering the client", describeRun(run))
    : failedOperation("Registering the client", {
        status: 0,
        error: "registration_refused",
        detail: describeRun(run),
      });

/**
 * The decoded claim set, for a member checking the artefact.
 *
 * Shown under the claims' own names, because the reader is comparing what Muster
 * minted against the published profile and a translated label would defeat that.
 * The two instants are rendered as instants: nobody reads epoch seconds.
 *
 * @param claims - the claims the statement carries
 * @returns the fields to show, in the profile's order
 * @example
 * ```tsx
 * <DetailList details={claimDetails(run.statement.claims)} />
 * ```
 */
export const claimDetails = (claims: StatementClaims): readonly Detail[] => [
  { label: "iss", value: claims.iss, mono: true },
  { label: "sub", value: claims.sub, mono: true },
  { label: "software_id", value: claims.software_id, mono: true },
  { label: "jti", value: claims.jti, mono: true },
  {
    label: "iat",
    value: new Date(claims.iat * 1000).toISOString(),
    mono: true,
  },
  {
    label: "exp",
    value: new Date(claims.exp * 1000).toISOString(),
    mono: true,
  },
  { label: "muster_event", value: claims.muster_event, mono: true },
  { label: "client_name", value: claims.client_name },
  { label: "redirect_uris", value: claims.redirect_uris, mono: true },
  { label: "grant_types", value: claims.grant_types, mono: true },
  {
    label: "token_endpoint_auth_method",
    value: claims.token_endpoint_auth_method,
    mono: true,
  },
  { label: "scope", value: claims.scope, mono: true },
  { label: "smart_launch_url", value: claims.smart_launch_url, mono: true },
];
