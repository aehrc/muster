/**
 * The pieces that render a verification check.
 *
 * Shared because the same three things appear on the event view, the system page and the
 * pairing detail, and three copies of a status cell would drift - the copy that drifted
 * being the one that shows an unreachable server as reachable.
 *
 * The wording of every claim these render comes from `./eventFilters.js`, where it is a pure
 * function with tests; the times come from `../formatting/times.js`. Neither belongs in a
 * component: what a status cell says about somebody else's server is worth a test.
 *
 * Author: John Grimes
 */

import { describeCheckStatus, describeDriftField } from "./eventFilters.js";
import { StatusIcon, StatusLabel } from "../components/icons.js";
import { DetailRow, EmptyState, Panel, Tag } from "../components/layout.js";
import { CHECK_TONE_STATES } from "../components/statusStates.js";
import { fullTime, shortTime } from "../formatting/times.js";

import type {
  CheckDetail,
  CheckStatus,
  CheckSummary,
  DriftFlag,
} from "@muster/contracts";
import type { ReactNode } from "react";

/** The status column of the event view's server table (FR-017, scenario 2). */
export function CheckStatusCell({
  check,
}: Readonly<{ readonly check: CheckStatus | null }>) {
  const status = describeCheckStatus(check, shortTime);
  return (
    <>
      <StatusLabel state={CHECK_TONE_STATES[status.tone]}>
        {status.text}
      </StatusLabel>
      {check === null || check.driftFlags.length === 0 ? null : (
        <div className="mt-1">
          <Tag>
            {check.driftFlags.length === 1
              ? "1 drift flag"
              : `${String(check.driftFlags.length)} drift flags`}
          </Tag>
        </div>
      )}
      {check === null ||
      check.permissionTicketTypesSupported.length === 0 ? null : (
        // FR-034 and scenario 3: which enrolled servers accept a permission ticket, said on
        // the event view itself and taken from what the check watched the server advertise.
        <div className="mt-1">
          <Tag>
            Permission tickets:{" "}
            {check.permissionTicketTypesSupported.join(", ")}
          </Tag>
        </div>
      )}
    </>
  );
}

/**
 * One disagreement, naming both values (FR-018).
 *
 * Both, because "there is drift" is not something an owner can act on - and the declared value
 * above the advertised one, as the wireframe's notice has it.
 */
export function DriftNotice({ flag }: Readonly<{ readonly flag: DriftFlag }>) {
  return (
    <div className="alert alert-warning alert-soft mt-2 items-start">
      <StatusIcon state="warning" />
      <div className="min-w-0">
        <strong>
          Drift: declared {describeDriftField(flag.field)} differs from
          advertised
        </strong>
        <div className="wrap-anywhere">Declared: {flag.declared}</div>
        <div className="wrap-anywhere">Advertised: {flag.advertised}</div>
      </div>
    </div>
  );
}

/** One value the server advertised, or nothing at all when it advertised none. */
function AdvertisedRow({
  label,
  value,
}: Readonly<{ readonly label: string; readonly value: string | null }>) {
  return value === null ? null : (
    <DetailRow label={label}>
      <span className="wrap-anywhere">{value}</span>
    </DetailRow>
  );
}

/**
 * The system page's verification panel.
 *
 * Everything here is a report of what somebody else's server said when asked, which is why it
 * is public: it carries no contact detail and nothing a participant typed privately.
 */
export function VerificationPanel({
  check,
  history,
  confirmedAt,
}: Readonly<{
  readonly check: CheckDetail | null;
  readonly history: readonly CheckSummary[];
  readonly confirmedAt: string;
}>): ReactNode {
  const status = describeCheckStatus(check, shortTime);

  return (
    <Panel
      title="Verification"
      description="Muster fetches this server's SMART configuration and CapabilityStatement on a schedule and reports what it finds."
    >
      <DetailRow label="Last check">
        <StatusLabel state={CHECK_TONE_STATES[status.tone]}>
          {status.text}
        </StatusLabel>
      </DetailRow>

      {check === null ? (
        <EmptyState>
          No check has run against this entry yet. Its status will appear within
          one check interval.
        </EmptyState>
      ) : (
        <>
          {check.detail === null ? null : (
            <DetailRow label="What happened">
              <span className="wrap-anywhere">{check.detail}</span>
            </DetailRow>
          )}
          <AdvertisedRow
            label="Advertised authorization endpoint"
            value={check.discovery?.authorizationEndpoint ?? null}
          />
          <AdvertisedRow
            label="Advertised token endpoint"
            value={check.discovery?.tokenEndpoint ?? null}
          />
          <AdvertisedRow
            label="Advertised registration endpoint"
            value={check.discovery?.registrationEndpoint ?? null}
          />
          {check.discovery === null ? null : (
            <DetailRow label="Permission ticket types accepted">
              {check.discovery.permissionTicketTypesSupported.length === 0
                ? "None advertised - this server has not said it accepts permission tickets"
                : check.discovery.permissionTicketTypesSupported.join(", ")}
            </DetailRow>
          )}
          {check.discovery === null ? null : (
            <DetailRow label="Scopes supported">
              {check.discovery.scopesSupported.length === 0
                ? "None advertised"
                : `${String(check.discovery.scopesSupported.length)}: ${check.discovery.scopesSupported.join(" ")}`}
            </DetailRow>
          )}
          <AdvertisedRow
            label="FHIR version"
            value={check.capability?.fhirVersion ?? null}
          />
          <AdvertisedRow
            label="Software"
            value={
              check.capability?.softwareName === null ||
              check.capability?.softwareName === undefined
                ? null
                : `${check.capability.softwareName} ${check.capability.softwareVersion ?? ""}`.trim()
            }
          />
          {check.driftFlags.map((flag) => (
            <DriftNotice flag={flag} key={flag.field} />
          ))}
        </>
      )}

      <DetailRow label="Details confirmed by its owner">
        {confirmedAt}
      </DetailRow>

      {history.length === 0 ? null : (
        <DetailRow label="Check history">
          <ul className="flex flex-col gap-1">
            {history.map((row) => (
              <li key={row.checkedAt}>
                <span className="wrap-anywhere">{fullTime(row.checkedAt)}</span>{" "}
                -{" "}
                {row.reachable
                  ? "reachable"
                  : (row.failureMode ?? "unreachable")}
              </li>
            ))}
          </ul>
        </DetailRow>
      )}
    </Panel>
  );
}
