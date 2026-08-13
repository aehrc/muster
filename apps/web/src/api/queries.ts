/**
 * Server state, through TanStack Query.
 *
 * Query keys are built here rather than written at call sites, because invalidation depends on
 * them matching: a mutation that invalidated `["organisations"]` while the list was cached
 * under `["organisations", "mine"]` would silently show stale data. One builder per resource
 * means the two cannot disagree.
 *
 * The hooks are deliberately thin - a key, a fetch and an invalidation list - and hold no logic
 * of their own. Everything worth testing lives in `../forms/` and `../pages/eventFilters.js` as
 * plain functions, which is why the console is excluded from the coverage denominator: its logic
 * is tested, its composition is covered by the end-to-end suite in a real browser.
 *
 * Author: John Grimes
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, patch, post, remove } from "./client.js";

import type {
  AdminAccount,
  EnrolledSystem,
  EnrolledSystemDetail,
  EventChange,
  EventDetail,
  EventSummary,
  Me,
  MyOrganisation,
  OrganisationContacts,
  PairingDetail,
  PairingOutcome,
  PairingSummary,
  RegistrationFieldsInput,
  SystemInput,
} from "@muster/contracts";
import type { QueryKey } from "@tanstack/react-query";

/** Every query key the console uses, so an invalidation cannot miss one. */
export const keys = {
  me: (): QueryKey => ["me"],
  events: (): QueryKey => ["events"],
  event: (slug: string): QueryKey => ["event", slug],
  eventSystems: (slug: string): QueryKey => ["event", slug, "systems"],
  eventSystem: (slug: string, systemId: string): QueryKey => [
    "event",
    slug,
    "systems",
    systemId,
  ],
  contacts: (organisationId: string): QueryKey => [
    "organisation",
    organisationId,
    "contacts",
  ],
  organisations: (): QueryKey => ["organisations"],
  pairings: (eventSlug?: string): QueryKey => [
    "pairings",
    eventSlug ?? "every-event",
  ],
  pairing: (id: string): QueryKey => ["pairing", id],
  accounts: (status: string): QueryKey => ["admin", "accounts", status],
} as const;

/** Who the caller is. Answered for an anonymous visitor too, with a null account. */
export function useMe() {
  return useQuery({
    queryKey: keys.me(),
    queryFn: async ({ signal }) => await get<Me>("/api/auth/me", signal),
  });
}

/** Every event. */
export function useEvents() {
  return useQuery({
    queryKey: keys.events(),
    queryFn: async ({ signal }) =>
      await get<{ events: EventSummary[] }>("/api/events", signal),
  });
}

/** One event's enrolled systems, and the event itself. */
export function useEventSystems(slug: string) {
  return useQuery({
    queryKey: keys.eventSystems(slug),
    queryFn: async ({ signal }) =>
      await get<{ event: EventDetail; systems: EnrolledSystem[] }>(
        `/api/events/${encodeURIComponent(slug)}/systems`,
        signal,
      ),
  });
}

/** One enrolled system, and the event it is enrolled in. */
export function useEventSystem(slug: string, systemId: string) {
  return useQuery({
    queryKey: keys.eventSystem(slug, systemId),
    queryFn: async ({ signal }) =>
      await get<{ event: EventDetail; system: EnrolledSystemDetail }>(
        `/api/events/${encodeURIComponent(slug)}/systems/${encodeURIComponent(systemId)}`,
        signal,
      ),
  });
}

/**
 * An organisation's contact details.
 *
 * `enabled` is the caller's, because this is the one read on the system detail page that needs
 * a session: an anonymous visitor sees the locked panel rather than a failed request.
 */
export function useContacts(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.contacts(organisationId),
    enabled,
    queryFn: async ({ signal }) =>
      await get<OrganisationContacts>(
        `/api/organisations/${encodeURIComponent(organisationId)}/contacts`,
        signal,
      ),
  });
}

/** The organisations the caller belongs to, with their members and systems. */
export function useMyOrganisations() {
  return useQuery({
    queryKey: keys.organisations(),
    queryFn: async ({ signal }) =>
      await get<{ organisations: MyOrganisation[] }>(
        "/api/organisations",
        signal,
      ),
  });
}

/** The accounts in one status, or all of them. */
export function useAdminAccounts(status: "pending" | "approved" | "all") {
  return useQuery({
    queryKey: keys.accounts(status),
    queryFn: async ({ signal }) =>
      await get<{ accounts: AdminAccount[] }>(
        status === "all"
          ? "/api/admin/accounts"
          : `/api/admin/accounts?status=${status}`,
        signal,
      ),
  });
}

/** What signing in, signing up, verifying or resending amounts to. */
export type CredentialAction =
  | {
      readonly kind: "sign-up";
      readonly email: string;
      readonly displayName: string;
      readonly password: string;
    }
  | {
      readonly kind: "sign-in";
      readonly email: string;
      readonly password: string;
    }
  | { readonly kind: "verify"; readonly token: string }
  | { readonly kind: "resend"; readonly email: string }
  | { readonly kind: "sign-out" };

/**
 * Signs up, in, out, verifies or resends.
 *
 * One mutation for all five, because they all end the same way: who the caller is has changed,
 * and everything the console knows about them is stale.
 */
export function useCredentialAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: CredentialAction) => {
      switch (action.kind) {
        case "sign-up": {
          return await post<Me>("/api/auth/sign-up", {
            email: action.email,
            displayName: action.displayName,
            password: action.password,
          });
        }
        case "sign-in": {
          return await post<Me>("/api/auth/sign-in", {
            email: action.email,
            password: action.password,
          });
        }
        case "verify": {
          return await post<Me>("/api/auth/verify", { token: action.token });
        }
        case "resend": {
          await post("/api/auth/resend-verification", { email: action.email });
          return;
        }
        default: {
          await post("/api/auth/sign-out");
          return;
        }
      }
    },
    onSuccess: async () => {
      // Everything, not just the session: which organisations the caller can see and which
      // admin pages they may read both change with who they are.
      await client.invalidateQueries();
    },
  });
}

/** What can be done to an organisation. */
export type OrganisationAction =
  | { readonly kind: "create"; readonly name: string }
  | { readonly kind: "invite"; readonly id: string; readonly email: string }
  | { readonly kind: "leave"; readonly id: string; readonly accountId: string };

/** Creates an organisation, invites into one, or leaves one. */
export function useOrganisationAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: OrganisationAction) => {
      if (action.kind === "create") {
        return await post<{ organisation: MyOrganisation }>(
          "/api/organisations",
          { name: action.name },
        );
      }
      if (action.kind === "invite") {
        return await post<{ organisation: MyOrganisation }>(
          `/api/organisations/${encodeURIComponent(action.id)}/members`,
          { email: action.email },
        );
      }
      await remove(
        `/api/organisations/${encodeURIComponent(action.id)}/members/${encodeURIComponent(action.accountId)}`,
      );
      return;
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.organisations() });
    },
  });
}

/** What can be done to a system. */
export type SystemAction =
  | {
      readonly kind: "create";
      readonly organisationId: string;
      readonly system: SystemInput;
    }
  | {
      readonly kind: "edit";
      readonly systemId: string;
      readonly system: SystemInput;
    };

/** Creates or replaces a system. */
export function useSystemAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: SystemAction) => {
      if (action.kind === "create") {
        return await post(
          `/api/organisations/${encodeURIComponent(action.organisationId)}/systems`,
          action.system,
        );
      }
      return await patch(
        `/api/systems/${encodeURIComponent(action.systemId)}`,
        action.system,
      );
    },
    onSuccess: async () => {
      // The organisation page and every event listing the system appears in.
      await client.invalidateQueries({ queryKey: keys.organisations() });
      await client.invalidateQueries({ queryKey: ["event"] });
    },
  });
}

/** Enrols a system in an event, confirming its details are current. */
export function useEnrolAction(slug: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      readonly systemId: string;
      readonly tags: readonly string[];
    }) =>
      await post(`/api/events/${encodeURIComponent(slug)}/enrolments`, {
        systemId: input.systemId,
        tags: input.tags,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.organisations() });
      await client.invalidateQueries({ queryKey: keys.eventSystems(slug) });
    },
  });
}

/**
 * The pairings the caller's organisations are party to, both directions.
 *
 * @param eventSlug - One event, or `undefined` for every event.
 */
export function usePairings(eventSlug?: string) {
  return useQuery({
    queryKey: keys.pairings(eventSlug),
    queryFn: async ({ signal }) =>
      await get<{ pairings: PairingSummary[] }>(
        eventSlug === undefined
          ? "/api/pairings"
          : `/api/pairings?event=${encodeURIComponent(eventSlug)}`,
        signal,
      ),
  });
}

/** One pairing, with the timeline both organisations read. */
export function usePairing(id: string) {
  return useQuery({
    queryKey: keys.pairing(id),
    queryFn: async ({ signal }) =>
      await get<{ pairing: PairingDetail }>(
        `/api/pairings/${encodeURIComponent(id)}`,
        signal,
      ),
  });
}

/** What requesting a pairing needs. */
export interface PairingRequestAction {
  readonly eventSlug: string;
  readonly clientEnrolmentId: string;
  readonly serverEnrolmentId: string;
  readonly registrationFields: RegistrationFieldsInput;
}

/** Requests a pairing between one of the caller's clients and an enrolled server. */
export function usePairingRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: PairingRequestAction) =>
      await post<PairingOutcome>("/api/pairings", action),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["pairings"] });
    },
  });
}

/** How the server's organisation answers a request. */
export type PairingAnswerAction =
  | { readonly kind: "fulfil"; readonly clientId: string }
  | { readonly kind: "decline"; readonly reason: string };

/**
 * Fulfils or declines a pairing.
 *
 * One mutation for both, because they end the same way: the pairing has a new state, a new
 * timeline entry, and the counterparty has been told.
 */
export function usePairingAnswer(pairingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: PairingAnswerAction) =>
      await post<PairingOutcome>(
        `/api/pairings/${encodeURIComponent(pairingId)}/${action.kind}`,
        action.kind === "fulfil"
          ? { clientId: action.clientId }
          : { reason: action.reason },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.pairing(pairingId) });
      await client.invalidateQueries({ queryKey: ["pairings"] });
    },
  });
}

/** Approves or revokes an account. */
export function useAccountDecision() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: {
      readonly accountId: string;
      readonly decision: "approve" | "revoke";
    }) =>
      await post<{ notified: boolean }>(
        `/api/admin/accounts/${encodeURIComponent(action.accountId)}/${action.decision}`,
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin", "accounts"] });
    },
  });
}

/** What can be done to an event. */
export type EventAction =
  | { readonly kind: "create"; readonly event: Record<string, unknown> }
  | {
      readonly kind: "edit";
      readonly slug: string;
      readonly patch: Record<string, unknown>;
    };

/** Creates an event, or edits one - including opening and closing it. */
export function useEventAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: EventAction) => {
      if (action.kind === "create") {
        return await post<EventChange>("/api/admin/events", action.event);
      }
      return await patch<EventChange>(
        `/api/admin/events/${encodeURIComponent(action.slug)}`,
        action.patch,
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.events() });
      await client.invalidateQueries({ queryKey: ["event"] });
    },
  });
}
