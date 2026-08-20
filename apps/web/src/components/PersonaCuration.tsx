/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  personaResponseSchema,
  personaSearchResponseSchema,
  personasResponseSchema,
} from "@muster/contracts";
import {
  AlertIcon,
  LinkExternalIcon,
  PlusIcon,
  SearchIcon,
} from "@primer/octicons-react";
import { useState } from "react";

import { TextField } from "./Fields.tsx";
import { OperationAlert } from "./OperationAlert.tsx";
import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import { describePersona, sourceNotice } from "../lib/personas.ts";

import type { Operation } from "../lib/operation.ts";
import type { EventSummary, PersonaSearchResponse } from "@muster/contracts";
import type { JSX } from "react";

/**
 * Curating an event's persona set, from its own source server.
 *
 * The admin never types an identifier: they search the source, and Muster reads the
 * patient it is shown. That is why the search is proxied rather than done in the
 * browser - the browser cannot reach through the SSRF guard, and a persona whose
 * IHI arrived from a form is a persona nothing anchors (FR-031).
 *
 * The patients that cannot be added are listed with their reasons rather than
 * dropped. An admin who can see a patient on the source server and cannot see it
 * here will assume the search is broken, so acceptance scenario 2 is a visible part
 * of this screen and not only an error on a request nobody made.
 *
 * @author John Grimes
 */

/**
 * Renders the persona curation panel for one event.
 *
 * @param props - the event whose set is being curated
 * @returns the panel
 * @example
 * ```tsx
 * <PersonaCuration event={event} />
 * ```
 */
export function PersonaCuration({
  event,
}: Readonly<{
  /** the event whose persona set is being curated */
  event: EventSummary;
}>): JSX.Element {
  const {
    data,
    operation: loading,
    reload,
  } = useResource(
    `/api/events/${event.slug}/personas`,
    personasResponseSchema,
    "Loading the personas",
  );
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PersonaSearchResponse | null>(null);
  const [operation, setOperation] = useState<Operation>(idle);

  const runSearch = async (): Promise<void> => {
    const what = "Searching the persona source";
    setOperation(pending(what));
    const result = await muster.get(
      `/api/admin/events/${event.slug}/persona-search?q=${encodeURIComponent(query)}`,
      personaSearchResponseSchema,
    );
    if (!result.ok) {
      setFound(null);
      setOperation(failed(what, result.failure));
      return;
    }
    setFound(result.data);
    setOperation(
      succeeded(
        what,
        `${String(result.data.candidates.length)} of the source's patients can be added; ` +
          `${String(result.data.ineligible.length)} carry no IHI.`,
      ),
    );
  };

  const addPersona = async (patientId: string): Promise<void> => {
    const what = `Adding Patient/${patientId}`;
    setOperation(pending(what));
    const result = await muster.post(
      `/api/admin/events/${event.slug}/personas`,
      { patientId },
      personaResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed(what, result.failure));
      return;
    }
    setOperation(
      succeeded(
        what,
        `${result.data.persona.display.name} joined the set with IHI ${result.data.persona.ihi}.`,
      ),
    );
    reload();
  };

  const source = data?.event.personaSourceUrl ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-3">
      <div className="flex flex-col gap-1">
        <h4 className="font-semibold">Personas</h4>
        {source === null ? (
          <p className="text-sm text-base-content/70">
            This event names no persona source, so there is nothing to search.
            Set one above first.
          </p>
        ) : (
          <p className="flex flex-wrap items-center gap-1 text-sm text-base-content/70">
            Curated from
            <code className="font-mono text-xs">{source}</code>
          </p>
        )}
      </div>

      <OperationAlert operation={loading} />
      <OperationAlert operation={operation} />

      {/* Each list names itself, so a reader moving between them - and a test
          driving them - can tell the set from what a search offered. */}
      <ul aria-label="Curated personas" className="flex flex-col gap-2">
        {(data?.personas ?? []).map((persona) => {
          const notice = sourceNotice(persona);
          return (
            <li
              key={persona.id}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-box border border-base-300 bg-base-100 p-2"
            >
              <div className="flex flex-col gap-1">
                <span className="font-semibold">{persona.display.name}</span>
                <span className="text-sm text-base-content/70">
                  {describePersona(persona)}
                </span>
                <code className="font-mono text-xs">{persona.ihi}</code>
                {notice === null ? null : (
                  <span className="flex items-center gap-1 text-sm text-error">
                    <AlertIcon size={12} />
                    {notice}
                  </span>
                )}
              </div>
              <a
                className="link link-hover flex items-center gap-1 text-sm"
                href={persona.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                <LinkExternalIcon size={12} />
                Source record
              </a>
            </li>
          );
        })}
        {data !== null && data.personas.length === 0 ? (
          <li className="text-sm text-base-content/70">
            No persona has been curated for this event yet.
          </li>
        ) : null}
      </ul>

      {source === null ? null : (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            void runSearch();
          }}
        >
          <div className="flex-1">
            <TextField
              label="Search the source"
              hint="A name, or a sixteen-digit IHI. Leave it empty to list what the source holds."
              placeholder="baratz"
              value={query}
              onChange={setQuery}
            />
          </div>
          <button
            type="submit"
            className="btn btn-sm"
            disabled={busy(operation)}
          >
            <SearchIcon size={14} />
            Search
          </button>
        </form>
      )}

      {found === null ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-base-content/60">
            Searched <code className="font-mono">{found.searched}</code>
          </p>
          <ul aria-label="Search results" className="flex flex-col gap-2">
            {found.candidates.map((candidate) => (
              <li
                key={candidate.patientId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 bg-base-100 p-2"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-semibold">
                    {candidate.display.name}
                  </span>
                  <span className="text-sm text-base-content/70">
                    {candidate.display.birthDate ?? "no birth date"}
                    {candidate.display.gender === null
                      ? ""
                      : `, ${candidate.display.gender}`}
                  </span>
                  <code className="font-mono text-xs">{candidate.ihi}</code>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  disabled={busy(operation)}
                  onClick={() => {
                    void addPersona(candidate.patientId);
                  }}
                >
                  <PlusIcon size={12} />
                  Add
                </button>
              </li>
            ))}
            {found.candidates.length === 0 ? (
              <li className="text-sm text-base-content/70">
                No patient carrying an IHI matched that search.
              </li>
            ) : null}
          </ul>

          {found.ineligible.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              {/* Reported rather than dropped: acceptance scenario 2 is a thing an
                  admin has to be able to see, not only an error on a request. */}
              <h5 className="text-sm font-semibold">
                Found, and cannot be added
              </h5>
              <ul
                aria-label="Found, and cannot be added"
                className="flex flex-col gap-1"
              >
                {found.ineligible.map((candidate) => (
                  <li
                    key={candidate.patientId}
                    className="text-sm text-base-content/70"
                  >
                    {/* The reason already names the patient, so it is not
                        repeated as a prefix. */}
                    {candidate.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
