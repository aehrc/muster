/**
 * Zod schemas shared by the server and the web console.
 *
 * The HTTP contract in `contracts/http-api.md` is expressed here so that one
 * definition validates requests on the server and types responses in the
 * browser.
 *
 * @author John Grimes
 */

export {
  accountStatusSchema,
  authorizationModeSchema,
  checkFailureModeSchema,
  coverageOutcomeSchema,
  errorEnvelopeSchema,
  eventStatusSchema,
  harnessCheckOutcomeSchema,
  harnessVerdictSchema,
  pageSchema,
  paginationSchema,
  pairingStateSchema,
  registrationModeSchema,
  type AccountStatus,
  type AuthorizationMode,
  type CheckFailureMode,
  type CoverageOutcome,
  type ErrorEnvelope,
  type EventStatus,
  type HarnessCheckOutcome,
  type HarnessVerdict,
  type Pagination,
  type PairingState,
  type RegistrationMode,
} from "./common.ts";
