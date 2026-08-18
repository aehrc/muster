import {
  addMemberRequestSchema,
  contactsResponseSchema,
} from "@muster/contracts";
import { PersonAddIcon, PeopleIcon, TrashIcon } from "@primer/octicons-react";
import { useState } from "react";

import { TextField } from "./Fields.tsx";
import { IssueList } from "./IssueList.tsx";
import { OperationAlert } from "./OperationAlert.tsx";
import { Panel } from "./Panel.tsx";
import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { parseRequest } from "../lib/forms.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";

import type { Operation } from "../lib/operation.ts";
import type { JSX } from "react";

/**
 * An organisation's members: who they are, adding one, and leaving.
 *
 * Every member of an organisation manages its systems and answers its pairings
 * (FR-005), so adding one is handing over real rights - which is why the server
 * refuses to add an account that is not itself approved, and why that refusal is
 * shown here in the server's own words rather than paraphrased.
 *
 * @author John Grimes
 */

/** What inviting is called in its messages. */
const inviting = "Adding the member";

/** What removing is called in its messages. */
const removing = "Removing the member";

/**
 * Renders the members panel.
 *
 * @param props - the organisation whose members to show, and what to do when the
 *   caller removes itself
 * @returns the panel
 * @example
 * ```tsx
 * <MembersPanel organisationId={id} onMembershipChanged={refresh} />
 * ```
 */
export function MembersPanel({
  organisationId,
  onMembershipChanged,
}: Readonly<{
  /** the organisation whose members to show */
  organisationId: string;
  /** called after a change, so the session's memberships are read again */
  onMembershipChanged: () => void;
}>): JSX.Element {
  const {
    data,
    operation: loading,
    reload,
  } = useResource(
    `/api/organisations/${organisationId}/contacts`,
    contactsResponseSchema,
    "Loading the members",
  );
  const [email, setEmail] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  const handleInvite = async (): Promise<void> => {
    const outcome = parseRequest(addMemberRequestSchema, { email });
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(inviting));
    const result = await muster.post(
      `/api/organisations/${organisationId}/members`,
      outcome.value,
      contactsResponseSchema,
    );
    if (result.ok) {
      setEmail("");
      setOperation(
        succeeded(inviting, `${outcome.value.email} is now a member.`),
      );
      reload();
      onMembershipChanged();
      return;
    }
    setOperation(failed(inviting, result.failure));
  };

  const handleRemove = async (accountId: string): Promise<void> => {
    setOperation(pending(removing));
    const result = await muster.delete(
      `/api/organisations/${organisationId}/members/${accountId}`,
      contactsResponseSchema,
    );
    if (result.ok) {
      setOperation(
        succeeded(
          removing,
          "Removed. The organisation and its systems stay listed; a track admin can add a member back.",
        ),
      );
      reload();
      onMembershipChanged();
      return;
    }
    setOperation(failed(removing, result.failure));
  };

  const working = busy(operation);

  return (
    <Panel
      title="Members"
      icon={<PeopleIcon size={18} />}
      description="Every member manages this organisation's systems and sees the contact details addressed to it."
    >
      <OperationAlert operation={loading} />
      <OperationAlert operation={operation} />

      {data === null ? null : (
        <ul className="flex flex-col divide-y divide-base-300">
          {data.contacts.map((contact) => (
            <li
              key={contact.accountId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="flex flex-col">
                <span>{contact.displayName}</span>
                <span className="font-mono text-xs text-base-content/70">
                  {contact.email}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={working}
                onClick={() => {
                  void handleRemove(contact.accountId);
                }}
              >
                <TrashIcon size={14} />
                Remove
              </button>
            </li>
          ))}
          {data.contacts.length === 0 ? (
            <li className="py-2 text-sm text-base-content/70">
              This organisation has no members. A track admin can add one.
            </li>
          ) : null}
        </ul>
      )}

      <IssueList issues={issues} />
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void handleInvite();
        }}
      >
        <div className="flex-1">
          <TextField
            label="Add a member"
            type="email"
            hint="The address of an account a track admin has already approved."
            value={email}
            onChange={setEmail}
          />
        </div>
        <button type="submit" className="btn btn-sm" disabled={working}>
          <PersonAddIcon size={16} />
          Add
        </button>
      </form>
    </Panel>
  );
}
