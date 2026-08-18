import { ShieldLockIcon } from "@primer/octicons-react";
import { Link } from "react-router";

import type { AccountStanding } from "../lib/account.ts";
import type { JSX } from "react";

/**
 * Why a screen is refusing to show its forms.
 *
 * Shown by every screen that needs write rights, so an account that is anonymous,
 * unverified, pending or revoked reads the same explanation of which condition it
 * fails wherever it lands - and is pointed at the one page that can do something
 * about it.
 *
 * @author John Grimes
 */

/** The alert class for each standing tone; Tailwind needs them written out. */
const classForTone: Record<AccountStanding["tone"], string> = {
  info: "alert-info",
  warning: "alert-warning",
  error: "alert-error",
  success: "alert-success",
};

/**
 * Renders an account's standing as a notice.
 *
 * @param props - the standing to explain
 * @returns the notice
 * @example
 * ```tsx
 * if (!standing.canWrite) {
 *   return <StandingNotice standing={standing} />;
 * }
 * ```
 */
export function StandingNotice({
  standing,
}: Readonly<{
  /** the standing to explain */
  standing: AccountStanding;
}>): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3">
      <div
        role="alert"
        className={`alert alert-soft ${classForTone[standing.tone]}`}
      >
        <ShieldLockIcon size={18} />
        <span>
          <strong>{standing.headline}.</strong> {standing.detail}
        </span>
      </div>
      <Link to="/sign-in" className="btn btn-primary btn-sm">
        Go to your account
      </Link>
    </div>
  );
}
