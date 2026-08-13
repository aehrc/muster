/**
 * The brands bundle, judged without a database.
 *
 * FR-022 asks for a per-event SMART User-access Brands bundle of the enrolled servers, and
 * US4 scenario 2 asks for it to be *valid* against that publication format - not merely
 * plausible. So the assertions here are the format's own requirements, read off the three
 * profiles the SMART App Launch IG publishes (`user-access-brands-bundle`,
 * `user-access-brand`, `user-access-endpoint`, all at version 2.2.0): the collection type,
 * `Bundle.meta.lastUpdated`, `Organization.name` and its single `telecom`, the reference
 * from a brand to an `Endpoint` that is actually in the bundle, the fixed
 * `hl7-fhir-rest` connection type, `Endpoint.address` being the FHIR base URL, the
 * placeholder payload type R4 requires, and the FHIR-version extension the endpoint profile
 * makes mandatory.
 *
 * The last case is the one that is not about shape. `exampleBundle.json` is a bundle this
 * builder produced, validated against FHIR R4 by the official validator and kept as a
 * fixture, and the builder is asserted to still produce it byte for byte. That is what
 * makes the validation evidence rather than a memory: changing what is emitted fails this
 * suite, and the fixture has to be revalidated before it passes again.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { buildBrandsBundle } from "./build.js";

import type { BrandsBundleInput, BrandServer } from "./build.js";
import type { Endpoint, Organization } from "fhir/r4";

/** The connection type the endpoint profile fixes. */
const CONNECTION_TYPE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/endpoint-connection-type";

/** The extension the endpoint profile requires at least one of. */
const FHIR_VERSION_EXTENSION =
  "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version";

/** A server enrolled in the event, with a check behind it. */
const MEDIRECORDS: BrandServer = {
  systemId: "6f1d2f0e-7d3a-4c58-9a3e-1b0c5d8e2f41",
  systemName: "MediRecords FHIR",
  fhirBaseUrl: "https://fhir.medirecords.example.com/r4",
  advertisedFhirVersion: "4.0.1",
  updatedAt: new Date("2026-08-10T04:15:00.000Z"),
};

/** A second server, which no check has read a CapabilityStatement from yet. */
const SIGNET: BrandServer = {
  systemId: "b83c9a14-2e77-4f0b-8d51-6c2a7f9e3b02",
  systemName: "Signet",
  fhirBaseUrl: "https://signet.example.com/fhir",
  advertisedFhirVersion: null,
  updatedAt: new Date("2026-08-12T09:30:00.000Z"),
};

/** The whole of one event's input, with both servers. */
function input(overrides: Partial<BrandsBundleInput> = {}): BrandsBundleInput {
  return {
    eventSlug: "sparked-2026-09",
    publicUrl: "https://muster.example.com",
    eventUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
    servers: [MEDIRECORDS, SIGNET],
    ...overrides,
  };
}

/** Every Organization in a bundle. */
function organisations(input: BrandsBundleInput): readonly Organization[] {
  return (buildBrandsBundle(input).entry ?? [])
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is Organization =>
        resource?.resourceType === "Organization",
    );
}

/** Every Endpoint in a bundle. */
function endpoints(input: BrandsBundleInput): readonly Endpoint[] {
  return (buildBrandsBundle(input).entry ?? [])
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is Endpoint => resource?.resourceType === "Endpoint",
    );
}

describe("the brands bundle", () => {
  // -------------------------------------------------------------------------
  // The bundle itself
  // -------------------------------------------------------------------------

  it("is a collection, which is what the bundle profile fixes", () => {
    const bundle = buildBrandsBundle(input());

    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
  });

  /**
   * `Bundle.meta.lastUpdated` is 1..1 in the bundle profile, and `Bundle.timestamp` is what
   * the specification names for advertising the last change to the contents. Both carry the
   * same instant.
   */
  it("advertises when its contents last changed", () => {
    const bundle = buildBrandsBundle(input());

    // The latest of everything in it: Signet's, which is after MediRecords' and after the
    // event's own.
    expect(bundle.meta?.lastUpdated).toBe("2026-08-12T09:30:00.000Z");
    expect(bundle.timestamp).toBe("2026-08-12T09:30:00.000Z");
  });

  /**
   * A caching reader has to be able to tell a changed bundle from an unchanged one, so the
   * timestamp is derived from the records rather than from the clock: two requests a minute
   * apart over unchanged data produce identical bytes.
   */
  it("does not move its timestamp when nothing has changed", () => {
    expect(buildBrandsBundle(input())).toEqual(buildBrandsBundle(input()));
  });

  /** With nothing enrolled there is nothing later than the event's own last change. */
  it("falls back to the event's own last change when nothing is enrolled", () => {
    const bundle = buildBrandsBundle(input({ servers: [] }));

    expect(bundle.meta?.lastUpdated).toBe("2026-08-01T00:00:00.000Z");
  });

  /**
   * An event with no enrolled servers publishes an empty bundle rather than a refusal: the
   * address is stable, and "no brands yet" is an answer an app can act on.
   */
  it("publishes an empty collection for an event with no enrolled servers", () => {
    const bundle = buildBrandsBundle(input({ servers: [] }));

    expect(bundle.type).toBe("collection");
    expect(bundle.entry ?? []).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // One brand and one endpoint per enrolled server
  // -------------------------------------------------------------------------

  it("carries one Organization and one Endpoint per enrolled server", () => {
    expect(organisations(input()).map((brand) => brand.name)).toEqual([
      "MediRecords FHIR",
      "Signet",
    ]);
    expect(endpoints(input()).map((endpoint) => endpoint.address)).toEqual([
      "https://fhir.medirecords.example.com/r4",
      "https://signet.example.com/fhir",
    ]);
  });

  /**
   * Event scoping, at this level, is that the bundle contains what it was given and nothing
   * else: a server the caller did not pass - because it is enrolled in another event, or in
   * none - cannot appear (scenario 3, FR-022). The route suite asserts the query half.
   */
  it("contains only the servers it was given", () => {
    const bundle = buildBrandsBundle(input({ servers: [MEDIRECORDS] }));

    expect(bundle.entry).toHaveLength(2);
    expect(JSON.stringify(bundle)).not.toContain("signet.example.com");
  });

  /** Every entry carries an absolute `fullUrl`, so a relative reference in it resolves. */
  it("gives every entry an absolute fullUrl under the event", () => {
    const bundle = buildBrandsBundle(input());

    expect((bundle.entry ?? []).map((entry) => entry.fullUrl)).toEqual([
      `https://muster.example.com/api/events/sparked-2026-09/Organization/${MEDIRECORDS.systemId}`,
      `https://muster.example.com/api/events/sparked-2026-09/Endpoint/${MEDIRECORDS.systemId}`,
      `https://muster.example.com/api/events/sparked-2026-09/Organization/${SIGNET.systemId}`,
      `https://muster.example.com/api/events/sparked-2026-09/Endpoint/${SIGNET.systemId}`,
    ]);
  });

  // -------------------------------------------------------------------------
  // The brand (Organization)
  // -------------------------------------------------------------------------

  /**
   * `Organization.endpoint.reference` is required by the brand profile to be a relative URL
   * to an Endpoint *within this bundle*, which is the whole mechanism by which an app gets
   * from a card to a base URL. A reference to an identifier nothing in the bundle carries
   * would be a bundle that discovers nothing.
   */
  it("references an Endpoint that is in the bundle", () => {
    const bundle = buildBrandsBundle(input());
    const ids = new Set(endpoints(input()).map((endpoint) => endpoint.id));

    const references = organisations(input()).flatMap((brand) =>
      (brand.endpoint ?? []).map((reference) => reference.reference),
    );

    expect(references).toEqual([
      `Endpoint/${MEDIRECORDS.systemId}`,
      `Endpoint/${SIGNET.systemId}`,
    ]);
    for (const reference of references) {
      expect(ids).toContain(reference?.replace("Endpoint/", ""));
    }
    expect(bundle.entry).toHaveLength(4);
  });

  /** Only enrolled entries are published, so every brand in the bundle is active. */
  it("marks every published brand active", () => {
    for (const brand of organisations(input())) {
      expect(brand.active).toBe(true);
    }
  });

  /**
   * The recommended brand identifier: `urn:ietf:rfc:3986` with the brand's HTTPS domain and
   * no path, which is the form `user_access_brand_identifier` in a server's
   * smart-configuration is matched against. Derived from the declared FHIR base URL,
   * because that is the only address of their own the owner has given the directory.
   */
  it("identifies each brand by its own HTTPS origin", () => {
    expect(organisations(input()).map((brand) => brand.identifier)).toEqual([
      [
        {
          system: "urn:ietf:rfc:3986",
          value: "https://fhir.medirecords.example.com",
        },
      ],
      [{ system: "urn:ietf:rfc:3986", value: "https://signet.example.com" }],
    ]);
  });

  /**
   * `Organization.telecom` is 1..1 in the brand profile: the brand's primary public
   * website. The directory's own public page for the enrolled system is the one such page
   * it can vouch for, and it is built from `MUSTER_PUBLIC_URL` like every other public URL.
   */
  it("points each brand at its public page in the directory", () => {
    expect(organisations(input()).map((brand) => brand.telecom)).toEqual([
      [
        {
          system: "url",
          value: `https://muster.example.com/events/sparked-2026-09/systems/${MEDIRECORDS.systemId}`,
        },
      ],
      [
        {
          system: "url",
          value: `https://muster.example.com/events/sparked-2026-09/systems/${SIGNET.systemId}`,
        },
      ],
    ]);
  });

  // -------------------------------------------------------------------------
  // The endpoint
  // -------------------------------------------------------------------------

  it("fixes the connection type the endpoint profile requires", () => {
    for (const endpoint of endpoints(input())) {
      expect(endpoint.connectionType).toEqual({
        system: CONNECTION_TYPE_SYSTEM,
        code: "hl7-fhir-rest",
      });
      expect(endpoint.status).toBe("active");
    }
  });

  /**
   * R4 makes `Endpoint.payloadType` 1..*, and the profile supplies the placeholder for a
   * user-access endpoint that carries no particular payload.
   */
  it("carries the placeholder payload type R4 insists on", () => {
    for (const endpoint of endpoints(input())) {
      expect(endpoint.payloadType).toEqual([
        {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/endpoint-payload-type",
              code: "none",
            },
          ],
        },
      ]);
    }
  });

  /**
   * `Endpoint.contact` is 1..* in the endpoint profile, sliced to a `url` where a developer
   * can arrange access. In this directory that is the system's own page, which is where a
   * developer requests a pairing.
   */
  it("tells a developer where to arrange access", () => {
    expect(endpoints(input()).map((endpoint) => endpoint.contact)).toEqual([
      [
        {
          system: "url",
          value: `https://muster.example.com/events/sparked-2026-09/systems/${MEDIRECORDS.systemId}`,
        },
      ],
      [
        {
          system: "url",
          value: `https://muster.example.com/events/sparked-2026-09/systems/${SIGNET.systemId}`,
        },
      ],
    ]);
  });

  /**
   * The FHIR-version extension is 1..* in the endpoint profile, so something has to be
   * emitted for a server no check has read a CapabilityStatement from. What the server
   * advertised is used when there is one, because that is the only authority on the
   * question; R4 is assumed otherwise, which is the version this directory's own contracts
   * and checks are written against.
   */
  it("publishes the FHIR version the server advertised", () => {
    const [medirecords] = endpoints(input({ servers: [MEDIRECORDS] }));

    expect(medirecords?.extension).toEqual([
      { url: FHIR_VERSION_EXTENSION, valueCode: "4.0.1" },
    ]);
  });

  it("assumes R4 for a server nothing has read a version from", () => {
    const [signet] = endpoints(input({ servers: [SIGNET] }));

    expect(signet?.extension).toEqual([
      { url: FHIR_VERSION_EXTENSION, valueCode: "4.0.1" },
    ]);
  });

  /**
   * A participant's server can advertise anything at all in `CapabilityStatement.fhirVersion`,
   * and this bundle is Muster's own published artefact: a server answering "R4" must not be
   * able to make it invalid. Only a value shaped like a FHIR version code is republished.
   */
  it("refuses to republish a version code that is not one", () => {
    const [endpoint] = endpoints(
      input({
        servers: [{ ...MEDIRECORDS, advertisedFhirVersion: "R4 (probably)" }],
      }),
    );

    expect(endpoint?.extension).toEqual([
      { url: FHIR_VERSION_EXTENSION, valueCode: "4.0.1" },
    ]);
  });

  it("republishes a version other than R4 when a server advertises one", () => {
    const [endpoint] = endpoints(
      input({ servers: [{ ...MEDIRECORDS, advertisedFhirVersion: "4.3.0" }] }),
    );

    expect(endpoint?.extension).toEqual([
      { url: FHIR_VERSION_EXTENSION, valueCode: "4.3.0" },
    ]);
  });

  // -------------------------------------------------------------------------
  // What is absent
  // -------------------------------------------------------------------------

  /**
   * The bundle is read by anybody (SC-006), so constitution principle V applies to it in
   * full: it is built from an explicit projection of five fields per server, and no address
   * of any person is among them. Asserted over the serialised bundle rather than field by
   * field, because the point is that nothing anywhere in it is a contact detail.
   */
  it("carries no personal contact detail", () => {
    const serialised = JSON.stringify(buildBrandsBundle(input()));

    expect(serialised).not.toContain("@");
    expect(serialised).not.toContain("mailto");
    for (const telecom of organisations(input()).flatMap(
      (brand) => brand.telecom ?? [],
    )) {
      expect(telecom.system).toBe("url");
    }
    for (const contact of endpoints(input()).flatMap(
      (endpoint) => endpoint.contact ?? [],
    )) {
      expect(contact.system).toBe("url");
    }
  });

  // -------------------------------------------------------------------------
  // The validated example
  // -------------------------------------------------------------------------

  /**
   * The bundle in `exampleBundle.json` was validated against FHIR R4 by the official HL7
   * validator: no errors, and four `dom-6` warnings - one per entry - which are the
   * best-practice recommendation that a resource carry a narrative. A brands bundle is read
   * by software and not rendered, so it carries none, and neither do the IG's own published
   * examples.
   *
   * This case is what keeps that validation true rather than remembered: the builder still
   * produces the validated bundle, so a change to what is emitted fails here and the fixture
   * has to be revalidated before it passes again.
   */
  it("still produces the example bundle that was validated", async () => {
    const expected = await Bun.file(
      new URL("exampleBundle.json", import.meta.url).pathname,
    ).json();

    expect(buildBrandsBundle(input())).toEqual(expected);
  });
});
