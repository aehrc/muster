import {
  createOrganisationRequestSchema,
  organisationResponseSchema,
} from "@muster/contracts";
import { OrganizationIcon, PlusIcon } from "@primer/octicons-react";
import { useState } from "react";

import { muster } from "../api/muster.ts";
import { TextField } from "../components/Fields.tsx";
import { IssueList } from "../components/IssueList.tsx";
import { MembersPanel } from "../components/MembersPanel.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { StandingNotice } from "../components/StandingNotice.tsx";
import { SystemsPanel } from "../components/SystemsPanel.tsx";
import { standingFor } from "../lib/account.ts";
import { parseRequest } from "../lib/forms.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import { useSession } from "../session/sessionContext.ts";

import type { Operation } from "../lib/operation.ts";
import type { JSX } from "react";

/**
 * The console: an approved member's organisations, their members and their systems.
 *
 * Acceptance scenario 3 is the shape of this screen. An approved member creates an
 * organisation and becomes its first member; every member can then add others and
 * manage the systems. An account that may not write is told which condition it
 * fails rather than being shown forms the server would refuse.
 *
 * @author John Grimes
 */

/** What creating an organisation is called in its messages. */
const creating = "Creating the organisation";

/**
 * The my-organisation screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function MyOrganisation(): JSX.Element {
  const { session, operation: sessionOperation, refresh } = useSession();
  const [name, setName] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);
  const [chosen, setChosen] = useState<string | null>(null);

  const standing = standingFor(session);
  const memberships = session?.memberships ?? [];
  const organisationId = chosen ?? memberships[0]?.organisationId ?? null;

  const handleCreate = async (): Promise<void> => {
    const outcome = parseRequest(createOrganisationRequestSchema, { name });
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(creating));
    const result = await muster.post(
      "/api/organisations",
      outcome.value,
      organisationResponseSchema,
    );
    if (result.ok) {
      setName("");
      setChosen(result.data.organisation.id);
      setOperation(
        succeeded(
          creating,
          `${result.data.organisation.name} created. You are its first member.`,
        ),
      );
      refresh();
      return;
    }
    setOperation(failed(creating, result.failure));
  };

  if (!standing.canWrite) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">My organisation</h1>
        <OperationAlert operation={sessionOperation} />
        <StandingNotice standing={standing} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold sm:text-3xl">My organisation</h1>
      <OperationAlert operation={sessionOperation} />
      <OperationAlert operation={operation} />

      {memberships.length > 1 ? (
        <div
          role="tablist"
          aria-label="Your organisations"
          className="tabs tabs-box self-start"
        >
          {memberships.map((membership) => (
            <button
              key={membership.organisationId}
              type="button"
              role="tab"
              aria-selected={membership.organisationId === organisationId}
              className={`tab ${membership.organisationId === organisationId ? "tab-active" : ""}`}
              onClick={() => {
                setChosen(membership.organisationId);
              }}
            >
              {membership.name}
            </button>
          ))}
        </div>
      ) : null}

      {organisationId === null ? null : (
        <>
          <MembersPanel
            organisationId={organisationId}
            onMembershipChanged={refresh}
          />
          <SystemsPanel organisationId={organisationId} />
        </>
      )}

      <Panel
        title={
          memberships.length === 0
            ? "Create your organisation"
            : "Create another organisation"
        }
        icon={<OrganizationIcon size={18} />}
        description="You become its first member, and can add other approved members afterwards."
      >
        <IssueList issues={issues} />
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div className="flex-1">
            <TextField
              label="Organisation name"
              placeholder="ACME Health"
              value={name}
              onChange={setName}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={busy(operation)}
          >
            <PlusIcon size={16} />
            Create
          </button>
        </form>
      </Panel>
    </div>
  );
}
