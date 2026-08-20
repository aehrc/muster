import {
  accountResponseSchema,
  accountsResponseSchema,
} from "@muster/contracts";
import {
  CheckIcon,
  PeopleIcon,
  ShieldSlashIcon,
  XIcon,
} from "@primer/octicons-react";
import { useState } from "react";

import { muster } from "../../api/muster.ts";
import { useResource } from "../../api/useResource.ts";
import { SelectField } from "../../components/Fields.tsx";
import { OperationAlert } from "../../components/OperationAlert.tsx";
import { Panel } from "../../components/Panel.tsx";
import { StandingNotice } from "../../components/StandingNotice.tsx";
import { standingFor } from "../../lib/account.ts";
import { busy, failed, idle, pending, succeeded } from "../../lib/operation.ts";
import { useSession } from "../../session/sessionContext.ts";

import type { Operation } from "../../lib/operation.ts";
import type { AccountStatus } from "@muster/contracts";
import type { JSX } from "react";

/**
 * The approval queue: approving accounts, and revoking them.
 *
 * Approval is the decision Muster is built around, because an approved member's
 * clients are the ones Muster later vouches for. It is standing rather than per
 * event, and revocable, and each decision reports what it did - including the
 * refusal when an account is already in the state the admin asked for, which is a
 * conflict rather than a second approval email (FR-002, FR-003).
 *
 * @author John Grimes
 */

/** The queues an admin can look at. */
const statusOptions = [
  { value: "pending", label: "Awaiting approval" },
  { value: "approved", label: "Approved" },
  { value: "revoked", label: "Revoked" },
];

/**
 * The admin members screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Members(): JSX.Element {
  const { session, operation: sessionOperation } = useSession();
  const [status, setStatus] = useState<AccountStatus>("pending");
  const [operation, setOperation] = useState<Operation>(idle);

  const {
    data,
    operation: loading,
    reload,
  } = useResource(
    `/api/admin/accounts?status=${status}`,
    accountsResponseSchema,
    "Loading the accounts",
  );

  const standing = standingFor(session);

  const decide = async (
    accountId: string,
    action: "approve" | "revoke",
    displayName: string,
  ): Promise<void> => {
    const what = `${action === "approve" ? "Approving" : "Revoking"} ${displayName}`;
    setOperation(pending(what));
    const result = await muster.post(
      `/api/admin/accounts/${accountId}/${action}`,
      {},
      accountResponseSchema,
    );
    if (result.ok) {
      setOperation(
        succeeded(
          what,
          `${displayName} is now ${result.data.account.status}, and has been emailed about it.`,
        ),
      );
      reload();
      return;
    }
    setOperation(failed(what, result.failure));
  };

  if (!standing.canAdminister) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Members</h1>
        <OperationAlert operation={sessionOperation} />
        <StandingNotice standing={standing} />
      </div>
    );
  }

  const accounts = data?.accounts ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold sm:text-3xl">Members</h1>
      <OperationAlert operation={loading} />
      <OperationAlert operation={operation} />

      <Panel
        title="Accounts"
        icon={<PeopleIcon size={18} />}
        description="Approval is standing: it persists across events, and it can be revoked."
      >
        <div className="sm:max-w-xs">
          <SelectField
            label="Show"
            options={statusOptions}
            value={status}
            onChange={(value) => {
              setStatus(
                value === "approved" || value === "revoked" ? value : "pending",
              );
            }}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Address verified</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.displayName}
                    {account.isAdmin ? (
                      <span className="badge badge-soft badge-primary badge-xs ms-2">
                        admin
                      </span>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs">{account.email}</td>
                  <td>
                    {account.emailVerified ? (
                      <CheckIcon size={16} />
                    ) : (
                      <XIcon size={16} />
                    )}
                  </td>
                  <td>
                    <span className="badge badge-accent badge-soft badge-sm">
                      {account.status}
                    </span>
                  </td>
                  <td className="text-end">
                    {account.status === "approved" ? (
                      <button
                        type="button"
                        className="btn btn-soft btn-error btn-xs"
                        disabled={busy(operation)}
                        onClick={() => {
                          void decide(
                            account.id,
                            "revoke",
                            account.displayName,
                          );
                        }}
                      >
                        <ShieldSlashIcon size={14} />
                        Revoke
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-xs"
                        disabled={busy(operation)}
                        onClick={() => {
                          void decide(
                            account.id,
                            "approve",
                            account.displayName,
                          );
                        }}
                      >
                        <CheckIcon size={14} />
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {accounts.length === 0 && data !== null ? (
          <p className="text-sm text-base-content/70">
            No account is in that state.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
