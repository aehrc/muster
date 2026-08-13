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
import { DetailRow, EmptyState, Panel, Tag } from "../components/layout.js";
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
      <span className={`check check-${status.tone}`}>{status.text}</span>
      {check === null || check.driftFlags.length === 0 ? null : (
        <div>
          <Tag>
            {check.driftFlags.length === 1
              ? "1 drift flag"
              : `${String(check.driftFlags.length)} drift flags`}
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
    <div className="state state-error">
      <strong>
        Drift: declared {describeDriftField(flag.field)} differs from advertised
      </strong>
      <div className="wrap">Declared: {flag.declared}</div>
      <div className="wrap">Advertised: {flag.advertised}</div>
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
      <span className="wrap">{value}</span>
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
        <span className={`check check-${status.tone}`}>{status.text}</span>
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
              <span className="wrap">{check.detail}</span>
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
          <ul className="plain-list">
            {history.map((row) => (
              <li key={row.checkedAt}>
                <span className="wrap">{fullTime(row.checkedAt)}</span> -{" "}
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
