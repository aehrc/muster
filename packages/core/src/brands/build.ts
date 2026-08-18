import type { EnrolledSystem, ServerProfile } from "@muster/contracts";
import type { Bundle, BundleEntry, Endpoint, Organization } from "fhir/r4";

/**
 * Building the per-event SMART User-access Brands bundle (FR-022).
 *
 * Pure. What arrives is the event's enrolled systems, exactly as the public read
 * API renders them, and what leaves is the FHIR Bundle the route serves: a
 * `UserAccessBrand` Organization and a `UserAccessEndpoint` Endpoint for each
 * enrolled server, linked to each other, in the publication format apps already
 * use for endpoint discovery (SMART App Launch 2.2.0, "User-access Brands and
 * Endpoints").
 *
 * Three decisions are worth stating, because the profiles are strict and the
 * directory does not know everything a brand publisher usually knows:
 *
 * - A brand is the enrolled server's owning organisation, and the system is the
 *   portal it offers: that is the structure the specification models, and it
 *   carries both names without inventing either.
 * - The FHIR version of an endpoint is only ever the one Muster has read out of
 *   that server's own capability statement, and only when it is a code the R4
 *   value set the extension binds to actually contains. Absent that, no version
 *   is published and the bundle stops claiming the profile, because a guessed
 *   version is worse than a missing one.
 * - A brand's public website is not something Muster collects, so it is reported
 *   as `asked-unknown` - the data-absent reason the specification permits for
 *   exactly this - rather than filled with something that is not the brand's.
 *
 * A contact detail cannot appear in the result: there is no element here that one
 * could reach, whatever the caller was permitted to see (FR-007).
 *
 * @author John Grimes
 */

/** The bundle profile a conformant publication claims. */
const bundleProfile =
  "http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle";

/** The extension carrying a brand's portal details. */
const portalExtension =
  "http://hl7.org/fhir/StructureDefinition/organization-portal";

/** The extension carrying an endpoint's FHIR version. */
const fhirVersionExtension =
  "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version";

/** The extension that says why a required value is absent. */
const dataAbsentReasonExtension =
  "http://hl7.org/fhir/StructureDefinition/data-absent-reason";

/** The code system endpoint connection types come from. */
const connectionTypeSystem =
  "http://terminology.hl7.org/CodeSystem/endpoint-connection-type";

/** The code system endpoint payload types come from. */
const payloadTypeSystem =
  "http://terminology.hl7.org/CodeSystem/endpoint-payload-type";

/** The identifier system for identifiers that are URLs. */
const urlIdentifierSystem = "urn:ietf:rfc:3986";

/**
 * The FHIR versions publishable in an R4 bundle.
 *
 * `endpoint-fhir-version` binds to `FHIRVersion` with a required strength, and
 * the User-access Brands profiles are R4, whose copy of that value set ends at
 * 4.0.1. A server advertising anything outside this set - an R5 server, say -
 * cannot have its version published here without making the bundle invalid, so
 * it is treated as a version Muster does not know.
 */
const publishableFhirVersions = new Set([
  "0.01",
  "0.05",
  "0.06",
  "0.11",
  "0.0.80",
  "0.0.81",
  "0.0.82",
  "0.4.0",
  "0.5.0",
  "1.0.0",
  "1.0.1",
  "1.0.2",
  "1.1.0",
  "1.4.0",
  "1.6.0",
  "1.8.0",
  "3.0.0",
  "3.0.1",
  "3.3.0",
  "3.5.0",
  "4.0.0",
  "4.0.1",
]);

/** What building one event's brands bundle needs. */
export type BrandsBundleFacts = {
  /** the event whose enrolled servers are published */
  readonly eventSlug: string;
  /** every system enrolled in that event, servers and clients alike */
  readonly systems: readonly EnrolledSystem[];
  /** the directory's public base URL, without a trailing slash */
  readonly publicUrl: string;
  /** when the bundle is being built, used only when it has no entries */
  readonly generatedAt: Date;
};

/** One enrolled server, as the bundle publishes it. */
type PublishedBrand = {
  /** the brand entry */
  readonly brand: BundleEntry<Organization>;
  /** the endpoint entry the brand references */
  readonly endpoint: BundleEntry<Endpoint>;
  /** the FHIR version published, absent when Muster does not know it */
  readonly fhirVersion: string | undefined;
  /** when this entry last changed, as an instant */
  readonly lastChangedAt: string;
};

/**
 * The page in the directory where this entry can be read and paired with.
 *
 * It doubles as the brand's identifier and as the endpoint's configuration URL,
 * because it is the one address at which a developer can do something about this
 * server, and it is stable for as long as the entry exists.
 *
 * @param facts - the event and the public base URL
 * @param systemId - the system the page is about
 * @returns the absolute URL of the entry's page
 */
const entryPage = (facts: BrandsBundleFacts, systemId: string): string =>
  `${facts.publicUrl}/events/${facts.eventSlug}/systems/${systemId}`;

/**
 * The identity of one resource in the bundle.
 *
 * @param facts - the event and the public base URL
 * @param resourceType - `Organization` or `Endpoint`
 * @param systemId - the system the resource is about
 * @returns the absolute URL that identifies the resource
 */
const resourceIdentity = (
  facts: BrandsBundleFacts,
  resourceType: "Organization" | "Endpoint",
  systemId: string,
): string =>
  `${facts.publicUrl}/api/events/${facts.eventSlug}/${resourceType}/${systemId}`;

/**
 * When an entry last changed.
 *
 * An app caches a bundle and re-fetches it when the contents have moved, so this
 * is the last thing that happened to the entry - its confirmation or its most
 * recent check - and never the moment of the request.
 *
 * @param system - the enrolled system
 * @returns the later of the confirmation and the latest check, as an instant
 */
const lastChangedAt = (system: EnrolledSystem): string => {
  const checkedAt = system.check?.latest.checkedAt;
  return checkedAt !== undefined &&
    Date.parse(checkedAt) > Date.parse(system.confirmedAt)
    ? checkedAt
    : system.confirmedAt;
};

/**
 * The FHIR version to publish for a server.
 *
 * @param system - the enrolled system
 * @returns the version its latest check read, when that is publishable here
 */
const publishedFhirVersion = (system: EnrolledSystem): string | undefined => {
  const advertised = system.check?.latest.capability?.fhirVersion;
  return advertised != null && publishableFhirVersions.has(advertised)
    ? advertised
    : undefined;
};

/**
 * Builds the `UserAccessEndpoint` for one enrolled server.
 *
 * @param facts - the event and the public base URL
 * @param system - the enrolled system
 * @param profile - its server profile
 * @param fhirVersion - the version to publish, when there is one
 * @returns the endpoint resource
 */
const endpointFor = (
  facts: BrandsBundleFacts,
  system: EnrolledSystem,
  profile: ServerProfile,
  fhirVersion: string | undefined,
): Endpoint => ({
  resourceType: "Endpoint",
  id: system.system.id,
  meta: { lastUpdated: lastChangedAt(system) },
  ...(fhirVersion === undefined
    ? {}
    : { extension: [{ url: fhirVersionExtension, valueCode: fhirVersion }] }),
  status: "active",
  connectionType: { system: connectionTypeSystem, code: "hl7-fhir-rest" },
  name: system.system.name,
  // Where a developer configures access to this endpoint: in Muster, the page
  // that says who owns it and from which a pairing is requested.
  contact: [{ system: "url", value: entryPage(facts, system.system.id) }],
  // R4 requires a payload type; the specification's own placeholder is used,
  // since a FHIR API endpoint does not exchange a particular payload.
  payloadType: [{ coding: [{ system: payloadTypeSystem, code: "none" }] }],
  address: profile.fhirBaseUrl,
});

/**
 * Builds the `UserAccessBrand` for one enrolled server.
 *
 * @param facts - the event and the public base URL
 * @param system - the enrolled system
 * @returns the organisation resource
 */
const brandFor = (
  facts: BrandsBundleFacts,
  system: EnrolledSystem,
): Organization => {
  const page = entryPage(facts, system.system.id);
  const endpoint = {
    reference: `Endpoint/${system.system.id}`,
    display: system.system.name,
  };
  return {
    resourceType: "Organization",
    id: system.system.id,
    meta: { lastUpdated: lastChangedAt(system) },
    extension: [
      {
        url: portalExtension,
        extension: [
          { url: "portalName", valueString: system.system.name },
          ...(system.system.description === ""
            ? []
            : [
                {
                  url: "portalDescription",
                  valueMarkdown: system.system.description,
                },
              ]),
          { url: "portalUrl", valueUrl: page },
          { url: "portalEndpoint", valueReference: endpoint },
        ],
      },
    ],
    // A URL identifier, so an app can merge this brand across publications.
    identifier: [{ system: urlIdentifierSystem, value: page }],
    // Only enrolled entries are published, and an enrolment is a confirmation
    // that the details are current.
    active: true,
    name: system.organisation.name,
    // The brand's own public website is not a detail the directory collects, and
    // the specification permits saying so rather than substituting one.
    telecom: [
      {
        system: "url",
        _value: {
          extension: [
            { url: dataAbsentReasonExtension, valueCode: "asked-unknown" },
          ],
        },
      },
    ],
    endpoint: [endpoint],
  };
};

/**
 * Publishes one enrolled server as a brand and an endpoint.
 *
 * @param facts - the event and the public base URL
 * @param system - the enrolled system
 * @param profile - its server profile
 * @returns the two entries, with what they could and could not assert
 */
const publish = (
  facts: BrandsBundleFacts,
  system: EnrolledSystem,
  profile: ServerProfile,
): PublishedBrand => {
  const fhirVersion = publishedFhirVersion(system);
  return {
    brand: {
      fullUrl: resourceIdentity(facts, "Organization", system.system.id),
      resource: brandFor(facts, system),
    },
    endpoint: {
      fullUrl: resourceIdentity(facts, "Endpoint", system.system.id),
      resource: endpointFor(facts, system, profile, fhirVersion),
    },
    fhirVersion,
    lastChangedAt: lastChangedAt(system),
  };
};

/**
 * Builds an event's SMART User-access Brands bundle.
 *
 * Only enrolled servers appear: a client has no FHIR endpoint to publish, and a
 * system that is not enrolled in the event is not part of the event (FR-022,
 * acceptance scenario 3).
 *
 * @param facts - the event, its enrolled systems, the public base URL and the clock
 * @returns the bundle, ready to serve as `application/fhir+json`
 * @example
 * ```ts
 * const bundle = buildBrandsBundle({
 *   eventSlug: event.slug,
 *   systems,
 *   publicUrl: config.publicUrl,
 *   generatedAt: new Date(),
 * });
 * ```
 */
export const buildBrandsBundle = (facts: BrandsBundleFacts): Bundle => {
  const published = facts.systems.flatMap((system) => {
    const profile = system.system.serverProfile;
    return profile === null ? [] : [publish(facts, system, profile)];
  });
  const entries = published.flatMap((entry) => [entry.brand, entry.endpoint]);
  // The last change to the contents, which is what an app compares against what
  // it already has; with nothing published there is nothing to date but now.
  const timestamp = published.reduce(
    (latest, entry) =>
      Date.parse(entry.lastChangedAt) > Date.parse(latest)
        ? entry.lastChangedAt
        : latest,
    published[0]?.lastChangedAt ?? facts.generatedAt.toISOString(),
  );
  // The profile is claimed only when every entry can satisfy it: an endpoint
  // whose FHIR version has never been read cannot carry the element the profile
  // requires, and a claim that cannot be kept is worse than no claim.
  const conformant = published.every(
    (entry) => entry.fhirVersion !== undefined,
  );
  return {
    resourceType: "Bundle",
    id: `brands-${facts.eventSlug}`,
    meta: {
      lastUpdated: timestamp,
      ...(conformant ? { profile: [bundleProfile] } : {}),
    },
    type: "collection",
    timestamp,
    ...(entries.length === 0 ? {} : { entry: entries }),
  };
};
