/**
 * What an event's status permits.
 *
 * Two requirements sit on these three functions. A closed event must refuse new
 * enrolments while staying readable (FR-011), and an enrolment's tags must be a subset
 * of the event's own (FR-009, `data-model.md`) - a tag nobody defined would appear as a
 * filter chip that matches one row and means nothing.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  acceptsEnrolments,
  canChangeEventStatus,
  unknownTags,
} from "./rules.js";

describe("canChangeEventStatus", () => {
  it("admits the transitions the data model names", () => {
    expect(canChangeEventStatus("draft", "open")).toBe(true);
    expect(canChangeEventStatus("open", "closed")).toBe(true);
  });

  it("refuses re-opening a closed event", () => {
    // Closing lapses open pairings and stops minting. Re-opening would leave those
    // pairings lapsed with no way back, so the refusal is the honest answer: a second
    // event is a second event.
    expect(canChangeEventStatus("closed", "open")).toBe(false);
  });

  it("refuses skipping a status, and refuses going backwards", () => {
    expect(canChangeEventStatus("draft", "closed")).toBe(false);
    expect(canChangeEventStatus("open", "draft")).toBe(false);
    expect(canChangeEventStatus("closed", "draft")).toBe(false);
  });

  it("refuses a transition to the status already held", () => {
    for (const status of ["draft", "open", "closed"] as const) {
      expect(canChangeEventStatus(status, status)).toBe(false);
    }
  });
});

describe("acceptsEnrolments", () => {
  it("admits only an open event", () => {
    // A draft event is one an admin is still assembling; a closed one keeps its records
    // readable and takes nothing new (FR-011).
    expect(acceptsEnrolments("open")).toBe(true);
    expect(acceptsEnrolments("draft")).toBe(false);
    expect(acceptsEnrolments("closed")).toBe(false);
  });
});

describe("unknownTags", () => {
  const defined = ["smart-app-host", "smart-app", "form-renderer-host"];

  it("finds nothing when every requested tag is defined", () => {
    expect(unknownTags(["smart-app"], defined)).toEqual([]);
    expect(unknownTags([], defined)).toEqual([]);
  });

  it("names each requested tag the event does not define", () => {
    // Named rather than counted: the participant has to know which of the four tags they
    // typed was the wrong one.
    expect(unknownTags(["smart-app", "ticket-issuer"], defined)).toEqual([
      "ticket-issuer",
    ]);
  });

  it("reports every unknown tag rather than stopping at the first", () => {
    expect(unknownTags(["a", "smart-app", "b"], defined)).toEqual(["a", "b"]);
  });

  it("treats an event with no tags as defining none", () => {
    expect(unknownTags(["smart-app"], [])).toEqual(["smart-app"]);
  });

  it("reports a duplicated unknown tag once", () => {
    // The message names values, and naming one twice reads as two different problems.
    expect(unknownTags(["a", "a"], defined)).toEqual(["a"]);
  });
});
