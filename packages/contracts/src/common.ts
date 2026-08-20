/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { z } from "zod";

/**
 * The vocabulary every part of Muster shares: the error envelope, pagination,
 * and the enumerations from `data-model.md`.
 *
 * One definition validates requests on the server and types responses in the
 * browser, so the two cannot drift on what a state is called or which states
 * exist.
 *
 * @author John Grimes
 */

/** Errors on the wire, per `contracts/http-api.md`. */
export const errorEnvelopeSchema = z.object({
  /** a short, stable machine-readable code */
  error: z.string().min(1),
  /** what went wrong, in words fit to show the caller */
  detail: z.string().min(1).optional(),
});

/** Errors on the wire. */
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Largest page a caller may ask for. */
const maximumPageSize = 200;

/** Page size when the caller does not ask for one. */
const defaultPageSize = 50;

/**
 * How a list request asks for a page. Values arriving as text from a query
 * string are read as numbers, so no route has to coerce them.
 */
export const paginationSchema = z.object({
  /** how many items to return */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(maximumPageSize)
    .default(defaultPageSize),
  /** how many items to skip */
  offset: z.coerce.number().int().min(0).default(0),
});

/** How a list request asks for a page. */
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Wraps an item schema as a page of results.
 *
 * @param item - the schema each item in the page satisfies
 * @returns a schema for a page of those items, with the totals a caller needs
 *   to page through the rest
 * @example
 * ```ts
 * const eventPageSchema = pageSchema(eventSummarySchema);
 * ```
 */
export const pageSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({
    /** the items on this page */
    items: z.array(item),
    /** how many items exist in total */
    total: z.number().int().nonnegative(),
    /** the page size used */
    limit: z.number().int().positive(),
    /** how many items were skipped */
    offset: z.number().int().nonnegative(),
  });

/** Account lifecycle: pending until an admin approves, revocable thereafter. */
export const accountStatusSchema = z.enum(["pending", "approved", "revoked"]);

/** Account lifecycle. */
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/** Event lifecycle: drafted, opened for enrolment, then closed. */
export const eventStatusSchema = z.enum(["draft", "open", "closed"]);

/** Event lifecycle. */
export type EventStatus = z.infer<typeof eventStatusSchema>;

/** Pairing lifecycle; transitions are the state machine's business. */
export const pairingStateSchema = z.enum([
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
]);

/** Pairing lifecycle. */
export type PairingState = z.infer<typeof pairingStateSchema>;

/** How a server authorises access. */
export const authorizationModeSchema = z.enum(["open", "smart"]);

/** How a server authorises access. */
export type AuthorizationMode = z.infer<typeof authorizationModeSchema>;

/**
 * How a server registers clients: not at all, by a human, or by accepting a
 * Muster-signed software statement.
 */
export const registrationModeSchema = z.enum(["open", "manual", "trustedDcr"]);

/** How a server registers clients. */
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

/**
 * What a signing key signs. Statements and tickets have separate keys, from the
 * same machinery, so that compromising one does not implicate the other.
 */
export const signingPurposeSchema = z.enum(["statements", "tickets"]);

/** What a signing key signs. */
export type SigningPurpose = z.infer<typeof signingPurposeSchema>;

/**
 * Whether a key is the one being signed with, or one kept published so that
 * artefacts signed before a rotation still verify (FR-024).
 */
export const signingKeyStatusSchema = z.enum(["active", "superseded"]);

/** Whether a key is the one being signed with. */
export type SigningKeyStatus = z.infer<typeof signingKeyStatusSchema>;

/**
 * Why a verification check did not reach a server. `guarded` means the address
 * guard refused it and no request was made.
 */
export const checkFailureModeSchema = z.enum([
  "timeout",
  "refused",
  "guarded",
  "invalid",
]);

/** Why a verification check did not reach a server. */
export type CheckFailureMode = z.infer<typeof checkFailureModeSchema>;

/** A conformance run's overall outcome; only `passed` earns the badge. */
export const harnessVerdictSchema = z.enum(["passed", "failed"]);

/** A conformance run's overall outcome. */
export type HarnessVerdict = z.infer<typeof harnessVerdictSchema>;

/**
 * One conformance check's outcome. `advisory` is where the registration profile
 * says SHOULD rather than MUST: reported, but the run still passes.
 */
export const harnessCheckOutcomeSchema = z.enum([
  "passed",
  "failed",
  "advisory",
]);

/** One conformance check's outcome. */
export type HarnessCheckOutcome = z.infer<typeof harnessCheckOutcomeSchema>;

/**
 * Whether a persona was found on a server. `unverifiable` is for servers that
 * refuse unauthenticated search: not a guess either way.
 */
export const coverageOutcomeSchema = z.enum([
  "found",
  "missing",
  "unverifiable",
]);

/** Whether a persona was found on a server. */
export type CoverageOutcome = z.infer<typeof coverageOutcomeSchema>;
