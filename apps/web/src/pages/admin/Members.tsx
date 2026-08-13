/**
 * Admin: the approval queue and the members already approved.
 *
 * The wireframe's two tables. There is no Reject button, and its absence is deliberate rather than
 * unfinished: `data-model.md` names three transitions - pending to approved, approved to revoked,
 * revoked to approved - so a sign-up nobody wants stays pending. Revocation means a member had
 * standing and lost it.
 *
 * Whether the member was emailed is shown, because the API says so and an approval whose
 * notification bounced is not the same outcome as one that arrived (FR-003, FR-037).
 *
 * Author: John Grimes
 */

import { AdminOnly } from "./AdminOnly.js";
import { describeError } from "../../api/errors.js";
import {
  useAccountDecision,
  useAdminAccounts,
  useMe,
} from "../../api/queries.js";
import {
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../../components/layout.js";

import type { AdminAccount } from "@muster/contracts";
import type { UseMutationResult } from "@tanstack/react-query";

/** The approval queue, and the members already approved. */
export function AdminMembers() {
  const me = useMe();
  const pending = useAdminAccounts("pending");
  const approved = useAdminAccounts("approved");
  const decision = useAccountDecision();

  if (me.data?.account?.isAdmin !== true) {
    return <AdminOnly title="Members" />;
  }

  return (
    <article className="page-wide">
      <PageHeader
        title="Members"
        subtitle="Approval is standing: it carries across events and can be revoked."
      />

      {decision.error === null ? null : (
        <ErrorAlert message={describeError(decision.error)} />
      )}
      {decision.isSuccess ? (
        <InfoAlert>
          {decision.data.notified
            ? "Decision recorded, and the member has been emailed."
            : "Decision recorded. The member could NOT be emailed - tell them another way."}
        </InfoAlert>
      ) : null}

      <Panel
        title="Awaiting approval"
        description="Accounts that have verified their address and are waiting for a decision. There is no reject: an account nobody wants stays pending."
      >
        <AccountTable
          accounts={pending.data?.accounts ?? []}
          pending={pending.isPending}
          error={pending.error}
          emptyMessage="Nobody is waiting."
          decision="approve"
          actionLabel="Approve"
          mutation={decision}
        />
      </Panel>

      <Panel
        title="Approved members"
        description="Revocation immediately stops entry edits, statement minting and ticket minting."
      >
        <AccountTable
          accounts={approved.data?.accounts ?? []}
          pending={approved.isPending}
          error={approved.error}
          emptyMessage="No approved members yet."
          decision="revoke"
          actionLabel="Revoke"
          mutation={decision}
        />
      </Panel>
    </article>
  );
}

/** One table of accounts with one action per row. */
function AccountTable({
  accounts,
  pending,
  error,
  emptyMessage,
  decision,
  actionLabel,
  mutation,
}: Readonly<{
  readonly accounts: readonly AdminAccount[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly emptyMessage: string;
  readonly decision: "approve" | "revoke";
  readonly actionLabel: string;
  readonly mutation: UseMutationResult<
    { notified: boolean },
    Error,
    { accountId: string; decision: "approve" | "revoke" }
  >;
}>) {
  if (pending) {
    return <Loading label="Loading the accounts" />;
  }
  if (error !== null && error !== undefined) {
    return <ErrorAlert message={describeError(error)} />;
  }
  if (accounts.length === 0) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Organisations</th>
          <th>{decision === "approve" ? "Signed up" : "Approved"}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => (
          <tr key={account.id}>
            <td>
              {account.displayName}
              {account.isAdmin ? <Tag>admin</Tag> : null}
            </td>
            <td className="wrap">{account.email}</td>
            <td>
              {account.organisations.length === 0 ? (
                <span className="quiet">none</span>
              ) : (
                account.organisations.map((organisation) => (
                  <Tag key={organisation.id}>{organisation.name}</Tag>
                ))
              )}
            </td>
            <td>
              {(decision === "approve"
                ? account.createdAt
                : (account.approvedAt ?? account.createdAt)
              ).slice(0, 10)}
            </td>
            <td>
              <button
                type="button"
                className={
                  decision === "approve" ? "button button-primary" : "button"
                }
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.mutate({ accountId: account.id, decision });
                }}
              >
                {actionLabel}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
