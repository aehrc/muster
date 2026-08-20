/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { enrolmentResponseSchema } from "@muster/contracts";
import { CheckCircleIcon, UploadIcon } from "@primer/octicons-react";
import { useState } from "react";

import { OperationAlert } from "./OperationAlert.tsx";
import { muster } from "../api/muster.ts";
import { describeAge } from "../lib/format.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";

import type { Operation } from "../lib/operation.ts";
import type {
  EnrolledSystem,
  EventDetail,
  SystemRecord,
} from "@muster/contracts";
import type { JSX } from "react";

/**
 * Enrolling one system into one event, with the tags it claims.
 *
 * Enrolment is a member's statement that the system's details are current, so
 * doing it again is a re-confirmation rather than a duplicate (SC-008): the button
 * says which of the two it is about to do, and the age of the last confirmation is
 * on screen while the person decides.
 *
 * The tags offered are the event's own (FR-009); nothing else can be chosen,
 * because the database refuses anything else and offering it would be a trap.
 *
 * @author John Grimes
 */

/**
 * Renders the enrolment control for one system.
 *
 * @param props - the event, the system, its existing enrolment if any, and what to
 *   do once it is enrolled
 * @returns the control
 * @example
 * ```tsx
 * <EnrolmentForm event={event} system={system} enrolment={existing} onEnrolled={reload} />
 * ```
 */
export function EnrolmentForm({
  event,
  system,
  enrolment,
  onEnrolled,
}: Readonly<{
  /** the event being enrolled into */
  event: EventDetail;
  /** the system being enrolled */
  system: SystemRecord;
  /** its existing enrolment, when it already has one */
  enrolment: EnrolledSystem | undefined;
  /** called once the enrolment is recorded */
  onEnrolled: () => void;
}>): JSX.Element {
  const [tags, setTags] = useState<readonly string[]>(enrolment?.tags ?? []);
  const [operation, setOperation] = useState<Operation>(idle);

  const what = enrolment === undefined ? "Enrolling" : "Re-confirming";
  const open = event.status === "open";

  const handleEnrol = async (): Promise<void> => {
    setOperation(pending(`${what} ${system.name}`));
    const result = await muster.post(
      `/api/events/${event.slug}/enrolments`,
      { systemId: system.id, tags },
      enrolmentResponseSchema,
    );
    if (result.ok) {
      setOperation(
        succeeded(
          `${what} ${system.name}`,
          `${system.name} is enrolled in ${event.name}, with its details confirmed just now.`,
        ),
      );
      onEnrolled();
      return;
    }
    setOperation(failed(`${what} ${system.name}`, result.failure));
  };

  return (
    <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {enrolment === undefined ? (
          <span className="text-base-content/70">
            Not enrolled in {event.name}.
          </span>
        ) : (
          <>
            <CheckCircleIcon size={14} />
            <span>
              Enrolled in {event.name}; details confirmed{" "}
              {describeAge(enrolment.confirmedAt, new Date())}.
            </span>
          </>
        )}
      </p>

      {event.capabilityTags.length === 0 ? null : (
        <fieldset className="fieldset">
          <legend className="fieldset-legend">Capability tags</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {event.capabilityTags.map((tag) => (
              <label
                key={tag}
                className="label cursor-pointer justify-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={tags.includes(tag)}
                  onChange={(changed) => {
                    setTags(
                      changed.currentTarget.checked
                        ? [...tags, tag]
                        : tags.filter((held) => held !== tag),
                    );
                  }}
                />
                <span>{tag}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy(operation) || !open}
          onClick={() => {
            void handleEnrol();
          }}
        >
          <UploadIcon size={16} />
          {enrolment === undefined
            ? `Enrol in ${event.name}`
            : "Re-confirm the details"}
        </button>
        {open ? null : (
          <span className="text-sm text-base-content/70">
            That event is {event.status}, so it takes nothing new.
          </span>
        )}
      </div>

      <OperationAlert operation={operation} />
    </div>
  );
}
