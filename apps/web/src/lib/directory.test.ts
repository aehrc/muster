import { describe, expect, test } from "bun:test";

import {
  contactsWithheld,
  emptyFilter,
  enrolmentFor,
  filterSystems,
  groupByKind,
  kindLabel,
  systemsOwnedBy,
  tagsOffered,
} from "./directory.ts";

import type { EnrolledSystem, EventDetail } from "@muster/contracts";

/**
 * The event view's grouping and filtering (FR-010), and the one question the
 * screen must never get wrong: whether contact details were withheld because the
 * reader is anonymous, or are genuinely absent.
 */

const serverProfile = {
  fhirBaseUrl: "https://fhir.medirecords.example.org",
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "",
} as const;

const clientProfile = {
  launchUrl: "https://smartforms.example.org/launch",
  redirectUris: ["https://smartforms.example.org/callback"],
  scopes: ["launch/patient"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
} as const;

// Builds an enrolled system, defaulting to a server owned by MediRecords.
const entry = (
  overrides: {
    readonly name?: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly server?: boolean;
    readonly client?: boolean;
    readonly organisation?: { readonly id: string; readonly name: string };
    readonly contacts?: readonly {
      accountId: string;
      displayName: string;
      email: string;
    }[];
  } = {},
): EnrolledSystem => {
  const server = overrides.server ?? true;
  const client = overrides.client ?? false;
  const organisation = overrides.organisation ?? {
    id: "org-1",
    name: "MediRecords",
  };
  return {
    enrolmentId: `enr-${overrides.name ?? "MediRecords FHIR"}`,
    tags: [...(overrides.tags ?? [])],
    confirmedAt: "2026-08-18T02:00:00.000Z",
    conformance: null,
    check: null,
    organisation,
    system: {
      id: `sys-${overrides.name ?? "MediRecords FHIR"}`,
      organisationId: organisation.id,
      name: overrides.name ?? "MediRecords FHIR",
      description: overrides.description ?? "",
      kinds: [
        ...(server ? (["server"] as const) : []),
        ...(client ? (["client"] as const) : []),
      ],
      serverProfile: server ? { ...serverProfile } : null,
      clientProfile: client
        ? {
            ...clientProfile,
            redirectUris: [...clientProfile.redirectUris],
            scopes: [...clientProfile.scopes],
          }
        : null,
    },
    ...(overrides.contacts === undefined
      ? {}
      : { contacts: [...overrides.contacts] }),
  };
};

const event: EventDetail = {
  slug: "sparked-2026-09",
  name: "Sparked connectathon",
  startsOn: "2026-09-01",
  endsOn: "2026-09-03",
  status: "open",
  capabilityTags: ["form renderer host", "form filler"],
  personaSourceUrl: null,
  graceDays: 7,
};

describe("kindLabel", () => {
  test("names each combination a system can be", () => {
    expect(kindLabel(["server"])).toBe("Server");
    expect(kindLabel(["client"])).toBe("Client");
    expect(kindLabel(["server", "client"])).toBe("Server and client");
    // A system with no profile cannot exist, but the label must not be blank if
    // one ever reaches the screen.
    expect(kindLabel([])).toBe("Unspecified");
  });
});

describe("groupByKind", () => {
  // FR-010: grouped by kind, and a system that is both appears under both,
  // because that is how someone looking for a server wants to find it.
  test("puts a system that is both a server and a client into both groups", () => {
    const both = entry({ name: "Both", client: true });
    const groups = groupByKind([entry({ name: "Server only" }), both]);

    expect(groups.map((group) => group.kind)).toEqual(["server", "client"]);
    expect(groups[0]?.systems.map((system) => system.system.name)).toEqual([
      "Server only",
      "Both",
    ]);
    expect(groups[1]?.systems.map((system) => system.system.name)).toEqual([
      "Both",
    ]);
  });

  test("keeps an empty group so the view can say the group is empty", () => {
    const groups = groupByKind([]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.systems.length === 0)).toBe(true);
  });
});

describe("filterSystems", () => {
  const systems = [
    entry({ name: "MediRecords FHIR", tags: ["form renderer host"] }),
    entry({
      name: "Smart Forms",
      server: false,
      client: true,
      tags: ["form filler"],
      organisation: { id: "org-2", name: "CSIRO" },
      description: "A questionnaire filler.",
    }),
  ];

  test("returns everything when nothing has been asked for", () => {
    expect(filterSystems(systems, emptyFilter)).toHaveLength(2);
  });

  test("narrows by kind", () => {
    expect(
      filterSystems(systems, { ...emptyFilter, kind: "client" }).map(
        (found) => found.system.name,
      ),
    ).toEqual(["Smart Forms"]);
  });

  test("narrows by capability tag", () => {
    expect(
      filterSystems(systems, { ...emptyFilter, tag: "form filler" }).map(
        (found) => found.system.name,
      ),
    ).toEqual(["Smart Forms"]);
  });

  // The text search covers what someone would actually type: the system, the
  // organisation, the description and the addresses.
  test("searches the name, the organisation, the description and the endpoints", () => {
    const byOrganisation = filterSystems(systems, {
      ...emptyFilter,
      text: "csiro",
    });
    expect(byOrganisation.map((found) => found.system.name)).toEqual([
      "Smart Forms",
    ]);

    expect(
      filterSystems(systems, { ...emptyFilter, text: "questionnaire" }),
    ).toHaveLength(1);
    expect(
      filterSystems(systems, { ...emptyFilter, text: "medirecords.example" }),
    ).toHaveLength(1);
    expect(
      filterSystems(systems, { ...emptyFilter, text: "smartforms.example" }),
    ).toHaveLength(1);
    expect(filterSystems(systems, { ...emptyFilter, text: "  " })).toHaveLength(
      2,
    );
    expect(
      filterSystems(systems, { ...emptyFilter, text: "no such thing" }),
    ).toHaveLength(0);
  });

  test("applies every criterion at once", () => {
    expect(
      filterSystems(systems, {
        kind: "server",
        tag: "form filler",
        text: "",
      }),
    ).toHaveLength(0);
  });
});

describe("tagsOffered", () => {
  // The event defines its own tags (FR-008), and a tag an enrolment carries that
  // the event has since dropped must still be filterable rather than orphaned.
  test("offers the event's tags plus any tag actually in use", () => {
    expect(
      tagsOffered(event, [entry({ tags: ["retired tag", "form filler"] })]),
    ).toEqual(["form filler", "form renderer host", "retired tag"]);
  });
});

describe("contactsWithheld", () => {
  // FR-007: absent because the reader is anonymous, not absent because there is
  // nobody to contact. The two look identical on the wire without this.
  test("distinguishes withheld contacts from an organisation with none", () => {
    expect(contactsWithheld(entry())).toBe(true);
    expect(contactsWithheld(entry({ contacts: [] }))).toBe(false);
    expect(
      contactsWithheld(
        entry({
          contacts: [
            { accountId: "a", displayName: "A Member", email: "a@example.org" },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("systemsOwnedBy and enrolmentFor", () => {
  const systems = [
    entry({ name: "MediRecords FHIR" }),
    entry({
      name: "Smart Forms",
      organisation: { id: "org-2", name: "CSIRO" },
    }),
  ];

  test("finds an organisation's own enrolments in the event", () => {
    expect(
      systemsOwnedBy(systems, "org-2").map((found) => found.system.name),
    ).toEqual(["Smart Forms"]);
  });

  test("finds the enrolment of one system, or reports none", () => {
    expect(enrolmentFor(systems, "sys-Smart Forms")?.enrolmentId).toBe(
      "enr-Smart Forms",
    );
    expect(enrolmentFor(systems, "sys-nothing")).toBeUndefined();
  });
});
