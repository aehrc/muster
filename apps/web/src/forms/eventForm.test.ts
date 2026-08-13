/**
 * Turning the event form into a request body.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  addCapabilityTag,
  createEventRequest,
  editEventRequest,
  EMPTY_EVENT_FORM,
  eventForm,
  removeCapabilityTag,
} from "./eventForm.js";

import type { EventDetail } from "@muster/contracts";

const EVENT: EventDetail = {
  slug: "sparked-2026-09",
  name: "Sparked Connectathon September 2026",
  startsOn: "2026-09-15",
  endsOn: "2026-09-19",
  status: "open",
  capabilityTags: ["smart-app-host", "smart-app"],
  personaSourceUrl: "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT",
  graceDays: 7,
};

describe("eventForm", () => {
  it("round-trips an event unchanged", () => {
    const request = createEventRequest(eventForm(EVENT));

    expect(request).toEqual({
      slug: EVENT.slug,
      name: EVENT.name,
      startsOn: EVENT.startsOn,
      endsOn: EVENT.endsOn,
      graceDays: 7,
      personaSourceUrl: EVENT.personaSourceUrl,
      capabilityTags: EVENT.capabilityTags,
    });
  });

  it("sends an absent persona source as null", () => {
    expect(
      createEventRequest({ ...EMPTY_EVENT_FORM, personaSourceUrl: "  " })
        .personaSourceUrl,
    ).toBeNull();
  });

  it("sends an unparseable grace period rather than substituting one", () => {
    // The grace period caps how long a minted credential outlives the event, so a default
    // nobody chose is the wrong kind of helpful.
    expect(
      Number.isNaN(
        createEventRequest({ ...EMPTY_EVENT_FORM, graceDays: "soon" })
          .graceDays as number,
      ),
    ).toBe(true);
  });
});

describe("editEventRequest", () => {
  it("leaves the slug out", () => {
    // Every public address for an event is built from it, so changing one would break the
    // links already handed out.
    expect(editEventRequest(eventForm(EVENT))).not.toHaveProperty("slug");
    expect(editEventRequest(eventForm(EVENT)).name).toBe(EVENT.name);
  });
});

describe("addCapabilityTag", () => {
  it("folds the case rather than refusing it", () => {
    // Two spellings of one tag split every filter that uses it.
    expect(addCapabilityTag([], " Smart-App-Host ")).toEqual([
      "smart-app-host",
    ]);
  });

  it("ignores a blank, and a tag already defined", () => {
    expect(addCapabilityTag(["a"], "   ")).toEqual(["a"]);
    expect(addCapabilityTag(["smart-app"], "SMART-APP")).toEqual(["smart-app"]);
  });

  it("keeps the order tags were added in", () => {
    expect(addCapabilityTag(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });
});

describe("removeCapabilityTag", () => {
  it("removes one tag and leaves the rest", () => {
    expect(removeCapabilityTag(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});
