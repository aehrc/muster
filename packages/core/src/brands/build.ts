/**
 * The event's enrolled servers, as a SMART User-access Brands bundle (FR-022).
 *
 * The bundle is the standards-native answer to "which endpoints are at this connectathon?" -
 * the format an app already reads before it has anything else, so an app that can discover a
 * production health system can discover a connectathon without being taught anything new.
 * Which is why it is built to the published profiles rather than to something bundle-shaped:
 * `user-access-brands-bundle`, `user-access-brand` and `user-access-endpoint` from SMART App
 * Launch 2.2.0. Where a profile fixes a value - the collection type, the `hl7-fhir-rest`
 * connection type, the `none` payload type R4's 1..* `payloadType` needs - it is fixed here.
 *
 * Pure, per constitution principle II: this is a projection of rows into FHIR, and the
 * server does the fetching. It does not read the clock either, and that is not only the
 * principle - `Bundle.timestamp` advertises the last change to the *contents*, so it is
 * computed from the records. Two requests a minute apart over unchanged data produce
 * identical bytes, which is what makes the bundle cacheable by a reader.
 *
 * ## Three fields the directory does not hold, and where they come from
 *
 * `Organization.telecom` is 1..1 in the brand profile - the brand's primary public website -
 * and `Endpoint.contact` is 1..* - a URL where a developer can arrange access. Muster stores
 * neither: what a participant declares about a server is its FHIR base URL and its
 * endpoints, not a marketing site. Both are answered with the directory's own public page
 * for the enrolled system, which is a page that exists, that describes exactly this brand,
 * and that is where a developer goes to request a pairing. Built from `MUSTER_PUBLIC_URL`,
 * like every other public URL Muster emits.
 *
 * `Endpoint.extension:fhir-version` is 1..*, and the only authority on a server's FHIR
 * version is the server. So the version comes from the latest check's CapabilityStatement
 * when one has been read, and R4 is assumed otherwise - the version this directory's own
 * contracts and checks are written against. What is *not* done is republishing the
 * advertised string unexamined: a participant's server can put anything in
 * `CapabilityStatement.fhirVersion`, and this bundle is Muster's artefact, so a value that
 * is not shaped like a FHIR version code is not allowed to make it invalid.
 *
 * ## What is absent
 *
 * No contact detail, because the bundle is anonymous (SC-006, constitution principle V), and
 * the projection below is five fields per server with no address among them. No brand logo,
 * no portal, no address and no organisation type either: every one of those is optional in
 * the profile and none is a fact the directory records. Inventing them would put claims in a
 * published artefact that no participant made.
 *
 * Author: John Grimes
 */

import type { Bundle, BundleEntry, Endpoint, Organization } from "fhir/r4";

/** The code system `Endpoint.connectionType` is drawn from. */
const CONNECTION_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/endpoint-connection-type";

/** The code system `Endpoint.payloadType` is drawn from. */
const PAYLOAD_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/endpoint-payload-type";

/** The extension the user-access endpoint profile requires at least one of. */
const FHIR_VERSION_EXTENSION =
  "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version";

/**
 * The identifier system the brands specification recommends for a brand.
 *
 * A plain URI, which is what `user_access_brand_identifier` in a server's
 * smart-configuration is matched against.
 */
const URI_IDENTIFIER_SYSTEM = "urn:ietf:rfc:3986";

/** The FHIR version assumed for a server that has not advertised one. */
const ASSUMED_FHIR_VERSION = "4.0.1";

/** What a published FHIR version code looks like. */
const FHIR_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * One enrolled server, as the bundle presents it.
 *
 * An explicit projection rather than a row: the same rule as `apps/server/src/http/views.ts`,
 * and for the same reason. A field added to the `system` table does not become part of a
 * published FHIR artefact without an edit here.
 */
export interface BrandServer {
  /** The system's identifier, which becomes the id of both of its resources. */
  readonly systemId: string;
  /** The brand name a reader sees on a card. */
  readonly systemName: string;
  /** The FHIR base URL its owner declared, which is `Endpoint.address`. */
  readonly fhirBaseUrl: string;
  /** `CapabilityStatement.fhirVersion` as the latest check read it, if one has. */
  readonly advertisedFhirVersion: string | null;
  /** When this server's record or enrolment last changed. */
  readonly updatedAt: Date;
}

/** Everything one event's bundle is built from. */
export interface BrandsBundleInput {
  readonly eventSlug: string;
  /** `MUSTER_PUBLIC_URL`, without a trailing slash. */
  readonly publicUrl: string;
  /** When the event itself last changed; the bundle's timestamp when nothing is enrolled. */
  readonly eventUpdatedAt: Date;
  /** The enrolled servers, in the order they should appear. */
  readonly servers: readonly BrandServer[];
}

/**
 * The directory's public page for one enrolled system.
 *
 * @param input - The event and the deployment's public URL.
 * @param systemId - The system.
 * @returns An absolute URL to the page the console serves.
 */
function systemPageUrl(input: BrandsBundleInput, systemId: string): string {
  return `${input.publicUrl}/events/${input.eventSlug}/systems/${systemId}`;
}

/**
 * The FHIR version to publish for a server.
 *
 * @param advertised - What the server's CapabilityStatement said, if anything.
 * @returns The advertised version when it is shaped like a FHIR version code, R4 otherwise.
 */
function publishableFhirVersion(advertised: string | null): string {
  return advertised !== null && FHIR_VERSION_PATTERN.test(advertised)
    ? advertised
    : ASSUMED_FHIR_VERSION;
}

/**
 * A brand's recommended identifier: its own origin, with no path.
 *
 * @param fhirBaseUrl - The declared FHIR base URL, which has passed `httpsUrlSchema`.
 * @returns The origin, for example `https://fhir.example.com`.
 */
function brandOrigin(fhirBaseUrl: string): string {
  return new URL(fhirBaseUrl).origin;
}

/**
 * One enrolled server's brand.
 *
 * @param input - The event's input, for the public URL.
 * @param server - The server.
 * @returns The Organization resource.
 */
function brand(input: BrandsBundleInput, server: BrandServer): Organization {
  return {
    resourceType: "Organization",
    id: server.systemId,
    identifier: [
      {
        system: URI_IDENTIFIER_SYSTEM,
        value: brandOrigin(server.fhirBaseUrl),
      },
    ],
    // Only enrolled servers are published, so everything in the bundle is a live brand.
    active: true,
    name: server.systemName,
    telecom: [{ system: "url", value: systemPageUrl(input, server.systemId) }],
    // Relative, which is what the brand profile requires: it resolves within this bundle.
    endpoint: [{ reference: `Endpoint/${server.systemId}` }],
  };
}

/**
 * One enrolled server's endpoint.
 *
 * @param input - The event's input, for the public URL.
 * @param server - The server.
 * @returns The Endpoint resource.
 */
function endpoint(input: BrandsBundleInput, server: BrandServer): Endpoint {
  return {
    resourceType: "Endpoint",
    id: server.systemId,
    extension: [
      {
        url: FHIR_VERSION_EXTENSION,
        valueCode: publishableFhirVersion(server.advertisedFhirVersion),
      },
    ],
    status: "active",
    connectionType: {
      system: CONNECTION_TYPE_SYSTEM,
      code: "hl7-fhir-rest",
    },
    // Technical rather than for display, per the profile's own note on this element.
    name: `FHIR endpoint for ${server.systemName}`,
    contact: [{ system: "url", value: systemPageUrl(input, server.systemId) }],
    payloadType: [{ coding: [{ system: PAYLOAD_TYPE_SYSTEM, code: "none" }] }],
    address: server.fhirBaseUrl,
  };
}

/**
 * When the bundle's contents last changed.
 *
 * @param input - The event and its servers.
 * @returns The latest of the event's own last change and every server's.
 */
function lastChangedAt(input: BrandsBundleInput): Date {
  return new Date(
    Math.max(
      input.eventUpdatedAt.getTime(),
      ...input.servers.map((server) => server.updatedAt.getTime()),
    ),
  );
}

/**
 * Builds one event's User-access Brands bundle.
 *
 * Every enrolled server contributes two entries, a brand and the endpoint it references, in
 * the order the servers were given. A server enrolled in another event - or in none - is
 * absent because it is not in `servers`, which is where scenario 3 is decided; and a client
 * is absent because it has no FHIR base URL to give an app.
 *
 * @param input - The event, the deployment's public URL, and the enrolled servers.
 * @returns The bundle, ready to serve as `application/fhir+json`.
 * @throws {TypeError} When a server's `fhirBaseUrl` is not a URL, which the input schema
 *   refuses before such a row can be stored.
 * @example
 * ```ts
 * const bundle = buildBrandsBundle({
 *   eventSlug: event.slug,
 *   publicUrl: context.config.publicUrl,
 *   eventUpdatedAt: event.updatedAt,
 *   servers,
 * });
 * ```
 */
export function buildBrandsBundle(input: BrandsBundleInput): Bundle {
  const changedAt = lastChangedAt(input).toISOString();
  const base = `${input.publicUrl}/api/events/${input.eventSlug}`;
  const entry: BundleEntry[] = input.servers.flatMap((server) => [
    {
      fullUrl: `${base}/Organization/${server.systemId}`,
      resource: brand(input, server),
    },
    {
      fullUrl: `${base}/Endpoint/${server.systemId}`,
      resource: endpoint(input, server),
    },
  ]);

  return {
    resourceType: "Bundle",
    id: input.eventSlug,
    // 1..1 in the bundle profile. The same instant as `timestamp`, which is the element the
    // specification's own prose names for advertising the last change to the contents.
    meta: { lastUpdated: changedAt },
    type: "collection",
    timestamp: changedAt,
    entry,
  };
}
