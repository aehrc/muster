/**
 * The system form, as data.
 *
 * A system carries two optional profiles with a dozen fields between them, several of which are
 * lists a person types as text. Turning a form's worth of strings into the request body
 * `systemInputSchema` accepts is the most error-prone thing the console does, so it is a pure
 * function with tests rather than logic scattered through a component.
 *
 * Every field is a string, including the booleans and the lists. That is deliberate: an input
 * holds text, and converting on every keystroke means a half-typed URL is briefly a different
 * value than what was typed. The conversion happens once, on submit, and an unparseable value is
 * sent as-is so the server names the field rather than the console guessing.
 *
 * Author: John Grimes
 */

import type { OrganisationSystem, SystemInput } from "@muster/contracts";

/** The system form's fields, all as text. */
export interface SystemForm {
  readonly name: string;
  readonly description: string;
  readonly isServer: boolean;
  readonly fhirBaseUrl: string;
  readonly authorizationMode: string;
  readonly registrationMode: string;
  readonly registrationEndpoint: string;
  readonly notes: string;
  readonly isClient: boolean;
  readonly launchUrl: string;
  /** One per line. */
  readonly redirectUris: string;
  /** Whitespace-separated, as SMART writes them. */
  readonly scopes: string;
  readonly confidentiality: string;
  readonly launchContext: string;
  readonly needsIntrospection: boolean;
}

/** An empty form, for a system being added. */
export const EMPTY_SYSTEM_FORM: SystemForm = {
  name: "",
  description: "",
  isServer: true,
  fhirBaseUrl: "",
  authorizationMode: "smart",
  registrationMode: "manual",
  registrationEndpoint: "",
  notes: "",
  isClient: false,
  launchUrl: "",
  redirectUris: "",
  scopes: "launch openid fhirUser",
  confidentiality: "public",
  launchContext: "",
  needsIntrospection: false,
};

/**
 * The form a system's current state fills.
 *
 * @param system - The system as the API reports it.
 * @returns The form, ready to be edited.
 * @example
 * ```ts
 * const [form, setForm] = useState<SystemForm | undefined>();
 * const values = form ?? systemForm(system);
 * ```
 */
export function systemForm(system: OrganisationSystem): SystemForm {
  const server = system.serverProfile;
  const client = system.clientProfile;
  return {
    name: system.name,
    description: system.description,
    isServer: server !== null,
    fhirBaseUrl: server?.fhirBaseUrl ?? "",
    authorizationMode: server?.authorizationMode ?? "smart",
    registrationMode: server?.registrationMode ?? "manual",
    registrationEndpoint: server?.registrationEndpoint ?? "",
    notes: server?.notes ?? "",
    isClient: client !== null,
    launchUrl: client?.launchUrl ?? "",
    redirectUris: (client?.redirectUris ?? []).join("\n"),
    scopes: (client?.scopes ?? []).join(" "),
    confidentiality: client?.confidentiality ?? "public",
    launchContext: client?.launchContext ?? "",
    needsIntrospection: client?.needsIntrospection ?? false,
  };
}

/** The non-empty lines of a textarea. */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The whitespace-separated words of a field. */
function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * The request body a form submits.
 *
 * Values that will not do are passed through rather than corrected: an unparseable URL is sent as
 * typed, so the server refuses it and names the field. The console guessing what was meant is how
 * a participant ends up with an entry they did not enter.
 *
 * A profile whose checkbox is off is sent as `null`, which is what makes an edit that turns a
 * system from both kinds into one actually remove the other profile.
 *
 * @param form - The form's current values.
 * @returns The body for `POST /api/organisations/{id}/systems` or `PATCH /api/systems/{id}`.
 * @example
 * ```ts
 * action.mutate({ kind: "create", organisationId, system: systemRequest(values) });
 * ```
 */
export function systemRequest(form: SystemForm): SystemInput {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    serverProfile: form.isServer
      ? {
          fhirBaseUrl: form.fhirBaseUrl.trim(),
          authorizationMode: form.authorizationMode as "open" | "smart",
          registrationMode: form.registrationMode as
            "open" | "manual" | "trustedDcr",
          registrationEndpoint:
            form.registrationEndpoint.trim().length === 0
              ? null
              : form.registrationEndpoint.trim(),
          notes: form.notes,
        }
      : null,
    clientProfile: form.isClient
      ? {
          launchUrl: form.launchUrl.trim(),
          redirectUris: lines(form.redirectUris),
          scopes: words(form.scopes),
          confidentiality: form.confidentiality as "public" | "confidential",
          launchContext: form.launchContext,
          needsIntrospection: form.needsIntrospection,
        }
      : null,
  };
}

/**
 * What is obviously wrong before the request is made.
 *
 * Only the things the server would refuse with a message a person cannot act on from the form:
 * a system that is neither kind, and a trusted-DCR server with nowhere to register. Everything
 * else is left to the server, so there is one authority on validity rather than two that can
 * disagree.
 *
 * @param form - The form's current values.
 * @returns A sentence to show, or `undefined` when the form may be submitted.
 */
export function systemFormProblem(form: SystemForm): string | undefined {
  if (!form.isServer && !form.isClient) {
    return "A system must be a server, a client, or both.";
  }
  if (
    form.isServer &&
    form.registrationMode === "trustedDcr" &&
    form.registrationEndpoint.trim().length === 0
  ) {
    return "A trusted DCR server must declare the registration endpoint statements are presented to.";
  }
  return undefined;
}
