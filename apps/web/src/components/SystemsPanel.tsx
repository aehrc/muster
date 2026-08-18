import {
  eventsResponseSchema,
  eventSystemsSchema,
  systemResponseSchema,
  systemsResponseSchema,
} from "@muster/contracts";
import { PencilIcon, PlusIcon, StackIcon } from "@primer/octicons-react";
import { useState } from "react";

import { EnrolmentForm } from "./EnrolmentForm.tsx";
import { SelectField } from "./Fields.tsx";
import { IssueList } from "./IssueList.tsx";
import { OperationAlert } from "./OperationAlert.tsx";
import { Panel } from "./Panel.tsx";
import { SystemForm } from "./SystemForm.tsx";
import { SystemProfiles } from "./SystemProfiles.tsx";
import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { enrolmentFor, kindLabel } from "../lib/directory.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import {
  buildSystemPatch,
  buildSystemRequest,
  emptySystemForm,
  systemFormFrom,
} from "../lib/systemForm.ts";

import type { Operation } from "../lib/operation.ts";
import type { SystemFormValues } from "../lib/systemForm.ts";
import type { SystemRecord } from "@muster/contracts";
import type { JSX } from "react";

/**
 * An organisation's systems: what it owns, editing one, and enrolling it.
 *
 * The three things a returning participant does are all on one screen because they
 * are one errand: check the record, correct it, confirm it is current for this
 * event. The enrolment control reads the event's own view, so what the panel says
 * about an enrolment is what the public directory says about it.
 *
 * @author John Grimes
 */

/** Which system's form is open, and with what values. */
type Editing = {
  /** the system being edited, or null for the new one */
  readonly systemId: string | null;
  /** the values in the form */
  readonly values: SystemFormValues;
};

/** What creating is called in its messages. */
const creating = "Adding the system";

/** What editing is called in its messages. */
const editing = "Saving the system";

/**
 * Renders the systems panel.
 *
 * @param props - the organisation whose systems to manage
 * @returns the panel
 * @example
 * ```tsx
 * <SystemsPanel organisationId={id} />
 * ```
 */
export function SystemsPanel({
  organisationId,
}: Readonly<{
  /** the organisation whose systems to manage */
  organisationId: string;
}>): JSX.Element {
  const systems = useResource(
    `/api/organisations/${organisationId}/systems`,
    systemsResponseSchema,
    "Loading your systems",
  );
  const events = useResource(
    "/api/events",
    eventsResponseSchema,
    "Loading the events",
  );
  const [slug, setSlug] = useState<string | null>(null);
  const chosen =
    slug ??
    events.data?.events.find((event) => event.status === "open")?.slug ??
    events.data?.events[0]?.slug ??
    null;
  const enrolments = useResource(
    chosen === null ? null : `/api/events/${chosen}/systems`,
    eventSystemsSchema,
    "Loading the event's enrolments",
  );

  const [form, setForm] = useState<Editing | null>(null);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  const handleSubmit = async (): Promise<void> => {
    if (form === null) {
      return;
    }
    const outcome =
      form.systemId === null
        ? buildSystemRequest(form.values)
        : buildSystemPatch(form.values);
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    const what = form.systemId === null ? creating : editing;
    setOperation(pending(what));
    const result =
      form.systemId === null
        ? await muster.post(
            `/api/organisations/${organisationId}/systems`,
            outcome.value,
            systemResponseSchema,
          )
        : await muster.patch(
            `/api/systems/${form.systemId}`,
            outcome.value,
            systemResponseSchema,
          );
    if (result.ok) {
      setForm(null);
      setOperation(succeeded(what, `${result.data.system.name} saved.`));
      systems.reload();
      enrolments.reload();
      return;
    }
    setOperation(failed(what, result.failure));
  };

  const openForm = (system: SystemRecord | null): void => {
    setIssues([]);
    setOperation(idle);
    setForm(
      system === null
        ? { systemId: null, values: emptySystemForm }
        : { systemId: system.id, values: systemFormFrom(system) },
    );
  };

  return (
    <Panel
      title="Systems"
      icon={<StackIcon size={18} />}
      description="A system is a server, a client, or both. Enrolling it into an event records that its details are current."
    >
      <OperationAlert operation={systems.operation} />
      <OperationAlert operation={events.operation} />
      <OperationAlert operation={operation} />

      {events.data === null || events.data.events.length === 0 ? null : (
        <div className="sm:max-w-md">
          <SelectField
            label="Event to enrol into"
            options={events.data.events.map((event) => ({
              value: event.slug,
              label: `${event.name} (${event.status})`,
            }))}
            value={chosen ?? ""}
            onChange={setSlug}
          />
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {(systems.data?.systems ?? []).map((system) => (
          <li
            key={system.id}
            className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <h3 className="font-semibold">{system.name}</h3>
                <span className="badge badge-soft badge-sm self-start">
                  {kindLabel(system.kinds)}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  openForm(form?.systemId === system.id ? null : system);
                }}
              >
                <PencilIcon size={14} />
                {form?.systemId === system.id ? "Cancel" : "Edit"}
              </button>
            </div>

            {form?.systemId === system.id ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSubmit();
                }}
              >
                <SystemForm
                  values={form.values}
                  onChange={(values) => {
                    setForm({ systemId: system.id, values });
                  }}
                />
                <IssueList issues={issues} />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm self-start"
                  disabled={busy(operation)}
                >
                  Save changes
                </button>
              </form>
            ) : (
              <SystemProfiles system={system} />
            )}

            {enrolments.data === null ? null : (
              <EnrolmentForm
                event={enrolments.data.event}
                system={system}
                enrolment={enrolmentFor(enrolments.data.systems, system.id)}
                onEnrolled={() => {
                  enrolments.reload();
                }}
              />
            )}
          </li>
        ))}
        {systems.data !== null && systems.data.systems.length === 0 ? (
          <li className="text-sm text-base-content/70">
            This organisation has no systems yet.
          </li>
        ) : null}
      </ul>

      {form?.systemId === null ? (
        <form
          className="flex flex-col gap-3 rounded-box border border-base-300 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <h3 className="font-semibold">A new system</h3>
          <SystemForm
            values={form.values}
            onChange={(values) => {
              setForm({ systemId: null, values });
            }}
          />
          <IssueList issues={issues} />
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy(operation)}
            >
              Add the system
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setForm(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-sm self-start"
          onClick={() => {
            openForm(null);
          }}
        >
          <PlusIcon size={16} />
          Add a system
        </button>
      )}
    </Panel>
  );
}
