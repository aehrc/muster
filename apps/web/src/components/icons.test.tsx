/**
 * The state vocabulary's two accessibility promises, asserted rather than asserted about.
 *
 * FR-004 says a state must be readable without its colour, which is only true while no two
 * states share a shape. FR-005 says the shapes are decorative, which is only true while every
 * one of them is hidden from assistive technology. Both are properties of a lookup table, so
 * both are cheap to check and would otherwise be checked by eye - once, on the day the table
 * was written.
 *
 * Author: John Grimes
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusIcon, StatusLabel } from "./icons.js";
import {
  ACCOUNT_STATUS_STATES,
  CHECK_TONE_STATES,
  COVERAGE_STATES,
  DCR_RUN_OUTCOME_STATES,
  DCR_STEP_STATES,
  EVENT_STATUS_STATES,
  HARNESS_OUTCOME_STATES,
  PAIRING_STATE_STATES,
  PERSONA_SOURCE_STATES,
  STATUS_STATES,
  VERDICT_TONE_STATES,
} from "./statusStates.js";

import type { StatusState } from "./statusStates.js";

/** The Octicon a state draws, taken from the class the package stamps on the SVG. */
function shapeOf(state: StatusState): string {
  const markup = renderToStaticMarkup(<StatusIcon state={state} />);
  return /octicon-([\w-]+)/.exec(markup)?.[1] ?? "";
}

describe("the state vocabulary", () => {
  // FR-004: shape carries the difference, so a reader who cannot tell the theme's success
  // colour from its error colour still reads two different states as two different states.
  test("gives every state a shape of its own", () => {
    const shapes = STATUS_STATES.map(shapeOf);
    expect(shapes.every((shape) => shape.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(STATUS_STATES.length);
  });

  // FR-005: the icon is decorative and the adjacent words carry the meaning, so a screen
  // reader must not announce it at all.
  test("hides every shape from assistive technology", () => {
    for (const state of STATUS_STATES) {
      expect(renderToStaticMarkup(<StatusIcon state={state} />)).toContain(
        'aria-hidden="true"',
      );
    }
  });

  // FR-005 again, from the other side: an icon never replaces a label.
  test("renders the words beside the shape", () => {
    const markup = renderToStaticMarkup(
      <StatusLabel state="bad">Unreachable</StatusLabel>,
    );
    expect(markup).toContain("Unreachable");
    expect(markup).toContain("octicon-x-circle");
  });
});

describe("the domain records", () => {
  /** Every record, with the surface it paints, for the shared assertions below. */
  const RECORDS: readonly (readonly [
    string,
    Readonly<Record<string, StatusState>>,
  ])[] = [
    ["verification outcomes", CHECK_TONE_STATES],
    ["harness check outcomes", HARNESS_OUTCOME_STATES],
    ["harness verdicts", VERDICT_TONE_STATES],
    ["persona coverage", COVERAGE_STATES],
    ["persona source standing", PERSONA_SOURCE_STATES],
    ["trusted-DCR steps", DCR_STEP_STATES],
    ["trusted-DCR run outcomes", DCR_RUN_OUTCOME_STATES],
    ["pairing states", PAIRING_STATE_STATES],
    ["account standing", ACCOUNT_STATUS_STATES],
    ["event lifecycle", EVENT_STATUS_STATES],
  ];

  // The property that makes the vocabulary usable: within one surface, two domain states
  // never land on the same shape, so the icon alone distinguishes them (FR-004).
  test.each(RECORDS)("give %s a distinct shape per state", (_name, record) => {
    const states = Object.values(record);
    expect(new Set(states.map(shapeOf)).size).toBe(states.length);
  });

  // The distinction FR-032 exists for: "we could not tell" must not be drawn as "it is not
  // there", on the surface where a reader would otherwise conflate them.
  test("keep unverifiable coverage apart from missing coverage", () => {
    expect(COVERAGE_STATES.unverifiable).not.toBe(COVERAGE_STATES.missing);
    expect(shapeOf(COVERAGE_STATES.unverifiable)).not.toBe(
      shapeOf(COVERAGE_STATES.missing),
    );
  });
});
