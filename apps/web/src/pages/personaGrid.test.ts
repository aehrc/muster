/**
 * What the persona page claims, in words.
 *
 * The sentences a reader acts on are the subject here: which event the page opens on when
 * nobody named one, what a grid cell says, and - the one that matters most - the difference
 * between a cell that says the patient is absent and one that says nothing could be
 * established. FR-032 turns on that difference, and a component cannot be asked about it.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  coverageIndex,
  coverageKey,
  describeCoverage,
  describeSourceStatus,
  openEventSlug,
} from "./personaGrid.js";

import type { EventSummary, PersonaCoverageCell } from "@muster/contracts";

/** An event summary with just the fields the picker reads. */
function event(slug: string, status: EventSummary["status"]): EventSummary {
  return {
    slug,
    name: slug,
    startsOn: "2026-09-15",
    endsOn: "2026-09-19",
    status,
  };
}

/** One cell of the grid. */
function cell(
  outcome: PersonaCoverageCell["outcome"],
  detail: string | null = null,
): PersonaCoverageCell {
  return {
    personaId: "11111111-1111-1111-1111-111111111111",
    enrolmentId: "22222222-2222-2222-2222-222222222222",
    outcome,
    detail,
    checkedAt: "2026-09-15T02:04:00.000Z",
  };
}

describe("openEventSlug", () => {
  it("uses the event the reader asked for", () => {
    expect(
      openEventSlug(
        [event("last-year", "closed"), event("now", "open")],
        "last-year",
      ),
    ).toBe("last-year");
  });

  it("falls back to an open event when the requested one does not exist", () => {
    // A stale link should land somewhere useful rather than on an empty page.
    expect(
      openEventSlug(
        [event("last-year", "closed"), event("now", "open")],
        "gone",
      ),
    ).toBe("now");
  });

  it("opens on the open event when nobody named one", () => {
    expect(
      openEventSlug([event("last-year", "closed"), event("now", "open")]),
    ).toBe("now");
  });

  it("falls back to the first event when none is open", () => {
    expect(openEventSlug([event("last-year", "closed")])).toBe("last-year");
  });

  it("has nothing to open when there are no events", () => {
    expect(openEventSlug([])).toBeUndefined();
  });
});

describe("coverageIndex", () => {
  it("finds a cell by its persona and its server", () => {
    const index = coverageIndex([cell("found")]);

    expect(
      index.get(
        coverageKey(
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
        ),
      )?.outcome,
    ).toBe("found");
  });

  it("has no entry for a pair nothing has checked", () => {
    // Absent, not `missing`: a server nobody has asked has not been found wanting.
    expect(coverageIndex([]).get(coverageKey("a", "b"))).toBeUndefined();
  });
});

describe("describeCoverage", () => {
  it("marks a server that holds the patient", () => {
    const described = describeCoverage(cell("found"));

    expect(described.tone).toBe("ok");
    expect(described.text).toContain("found");
  });

  it("marks a server that does not", () => {
    const described = describeCoverage(
      cell("missing", "The server holds no patient"),
    );

    expect(described.tone).toBe("bad");
    expect(described.text).toContain("missing");
  });

  it("marks a server that could not be asked, distinctly from one that said no", () => {
    // The whole point of FR-032: an authorization failure is not evidence of absence, and a
    // reader must be able to tell the two apart at a glance.
    const unverifiable = describeCoverage(
      cell(
        "unverifiable",
        "The server requires authorization for patient searches",
      ),
    );

    expect(unverifiable.tone).toBe("unknown");
    expect(unverifiable.text).toContain("unverifiable");
    expect(unverifiable.tone).not.toBe(describeCoverage(cell("missing")).tone);
  });

  it("carries the server's own reason, for the cell's title", () => {
    const described = describeCoverage(
      cell(
        "unverifiable",
        "The server requires authorization for patient searches",
      ),
    );

    expect(described.detail).toContain("authorization");
  });

  it("says nothing has been checked rather than showing a blank cell", () => {
    const described = describeCoverage(undefined);

    expect(described.tone).toBe("none");
    expect(described.text.length).toBeGreaterThan(0);
  });
});

describe("describeSourceStatus", () => {
  it("says nothing loud about a persona the source still holds", () => {
    expect(describeSourceStatus("present").flagged).toBe(false);
  });

  it("flags a persona the source no longer holds (FR-032 edge case)", () => {
    const described = describeSourceStatus("missing");

    expect(described.flagged).toBe(true);
    expect(described.text).toContain("source");
  });
});
