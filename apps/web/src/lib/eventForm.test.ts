/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  buildEventPatch,
  buildEventRequest,
  emptyEventForm,
  eventFormFrom,
} from "./eventForm.ts";

import type { EventFormValues } from "./eventForm.ts";
import type { EventDetail } from "@muster/contracts";

/**
 * The event form: an event's name, dates, status and capability tags (FR-008).
 *
 * Capability tags are defined per event and typed as a list, so most of what is
 * tested here is that a list someone typed becomes the list the contract wants.
 */

const filled: EventFormValues = {
  ...emptyEventForm,
  slug: "sparked-2026-09",
  name: "Sparked connectathon",
  startsOn: "2026-09-01",
  endsOn: "2026-09-03",
  status: "open",
  capabilityTags: "form renderer host\nform filler",
  graceDays: "7",
};

describe("buildEventRequest", () => {
  test("builds the creation request from the form", () => {
    const outcome = buildEventRequest(filled);

    expect(outcome).toEqual({
      ok: true,
      value: {
        slug: "sparked-2026-09",
        name: "Sparked connectathon",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        status: "open",
        capabilityTags: ["form renderer host", "form filler"],
        graceDays: 7,
      },
    });
  });

  // Tags are multi-word ("form renderer host"), so they are read one per line
  // rather than split on whitespace like a scope list.
  test("reads capability tags one per line, keeping the spaces inside them", () => {
    const outcome = buildEventRequest({
      ...filled,
      capabilityTags: "  form renderer host  \n\n data holder \n",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.capabilityTags).toEqual([
      "form renderer host",
      "data holder",
    ]);
  });

  test("omits the persona source and the grace period when neither was given", () => {
    const outcome = buildEventRequest({ ...filled, graceDays: "" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect("graceDays" in outcome.value).toBe(false);
    expect(outcome.value.personaSourceUrl ?? null).toBeNull();
  });

  test("carries a persona source when one was given", () => {
    const outcome = buildEventRequest({
      ...filled,
      personaSourceUrl: "https://fhir.example.org/dev",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.personaSourceUrl).toBe("https://fhir.example.org/dev");
  });

  // The slug is in every public URL for the event, so the contract constrains it
  // and the console reports the refusal against the field.
  test("refuses a slug that is not lower-case, digits and hyphens", () => {
    const outcome = buildEventRequest({ ...filled, slug: "Sparked 2026" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.issues.join(" ")).toContain("slug");
  });

  test("refuses a date that is not a day", () => {
    expect(buildEventRequest({ ...filled, endsOn: "3 September" }).ok).toBe(
      false,
    );
  });

  test("refuses a grace period that is not a number", () => {
    expect(buildEventRequest({ ...filled, graceDays: "a while" }).ok).toBe(
      false,
    );
  });
});

describe("buildEventPatch", () => {
  // The slug identifies the event and is not part of what an edit may change.
  test("builds an edit without the slug", () => {
    const outcome = buildEventPatch({ ...filled, status: "closed" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect("slug" in outcome.value).toBe(false);
    expect(outcome.value.status).toBe("closed");
  });

  // Clearing the persona source is a change, not an omission.
  test("clears the persona source when the field is emptied", () => {
    const outcome = buildEventPatch({ ...filled, personaSourceUrl: "" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.personaSourceUrl).toBeNull();
  });
});

describe("eventFormFrom", () => {
  test("fills the form from a stored event and round trips it", () => {
    const stored: EventDetail = {
      slug: "sparked-2026-09",
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "draft",
      capabilityTags: ["form renderer host", "form filler"],
      personaSourceUrl: "https://fhir.example.org/dev",
      graceDays: 14,
    };

    const values = eventFormFrom(stored);

    expect(values.capabilityTags).toBe("form renderer host\nform filler");
    expect(values.graceDays).toBe("14");
    expect(values.status).toBe("draft");

    const outcome = buildEventPatch(values);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value).toEqual({
      name: stored.name,
      startsOn: stored.startsOn,
      endsOn: stored.endsOn,
      status: stored.status,
      capabilityTags: stored.capabilityTags,
      personaSourceUrl: stored.personaSourceUrl,
      graceDays: stored.graceDays,
    });
  });

  test("leaves an absent persona source empty", () => {
    expect(
      eventFormFrom({
        slug: "a",
        name: "A",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        status: "open",
        capabilityTags: [],
        personaSourceUrl: null,
        graceDays: 0,
      }).personaSourceUrl,
    ).toBe("");
  });
});
