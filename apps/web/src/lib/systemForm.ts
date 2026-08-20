/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  createSystemRequestSchema,
  updateSystemRequestSchema,
} from "@muster/contracts";

import { joinList, parseRequest, splitList } from "./forms.ts";

import type { ParseOutcome } from "./forms.ts";
import type {
  AuthorizationMode,
  ClientConfidentiality,
  CreateSystemRequest,
  RegistrationMode,
  SystemRecord,
  UpdateSystemRequest,
} from "@muster/contracts";

/**
 * The system form's field set (FR-006), as a browser can hold it.
 *
 * Inputs hold text and checkboxes; the contract wants lists, enumerations and
 * two optional profiles. This module is the whole of that translation, in both
 * directions, so the form component holds no logic beyond binding fields, and a
 * round trip - stored system to form to patch - is a test rather than a hope.
 *
 * A system is a server, a client, or both, never neither. That refusal is stated
 * here in the words the person needs ("choose whether this system is...") rather
 * than relayed from the schema, which describes profiles rather than choices.
 *
 * @author John Grimes
 */

/** Every field of the system form, as text and checkboxes. */
export type SystemFormValues = {
  /** the system's name */
  readonly name: string;
  /** what it is for */
  readonly description: string;
  /** whether it has a server profile */
  readonly isServer: boolean;
  /** whether it has a client profile */
  readonly isClient: boolean;
  /** the server's FHIR base URL */
  readonly fhirBaseUrl: string;
  /** how the server authorises access */
  readonly authorizationMode: AuthorizationMode;
  /** how the server registers clients */
  readonly registrationMode: RegistrationMode;
  /** where the server says it authorises, for drift detection */
  readonly authorizationEndpoint: string;
  /** where the server says it issues tokens, for drift detection */
  readonly tokenEndpoint: string;
  /** where a trusted-DCR server accepts registrations */
  readonly registrationEndpoint: string;
  /** anything a person registering needs to know */
  readonly notes: string;
  /** the client's launch URL */
  readonly launchUrl: string;
  /** the client's redirect URIs, one per line */
  readonly redirectUris: string;
  /** the scopes the client asks for */
  readonly scopes: string;
  /** whether the client can keep a secret */
  readonly confidentiality: ClientConfidentiality;
  /** the launch context the client needs */
  readonly launchContext: string;
  /** whether the client needs token introspection */
  readonly needsIntrospection: boolean;
};

/** An empty form. */
export const emptySystemForm: SystemFormValues = {
  name: "",
  description: "",
  isServer: false,
  isClient: false,
  fhirBaseUrl: "",
  authorizationMode: "smart",
  registrationMode: "manual",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  registrationEndpoint: "",
  notes: "",
  launchUrl: "",
  redirectUris: "",
  scopes: "",
  confidentiality: "public",
  launchContext: "",
  needsIntrospection: false,
};

/** What the console says when neither kind was chosen. */
const noKindChosen = [
  "kinds: Choose whether this system is a server, a client, or both.",
];

/**
 * Fills the form from a stored system.
 *
 * @param system - the system as stored
 * @returns the form values, with the half the system does not have left empty
 * @example
 * ```ts
 * const [values, setValues] = useState(systemFormFrom(system));
 * ```
 */
export const systemFormFrom = (system: SystemRecord): SystemFormValues => ({
  ...emptySystemForm,
  name: system.name,
  description: system.description,
  isServer: system.serverProfile !== null,
  isClient: system.clientProfile !== null,
  ...(system.serverProfile === null
    ? {}
    : {
        fhirBaseUrl: system.serverProfile.fhirBaseUrl,
        authorizationMode: system.serverProfile.authorizationMode,
        registrationMode: system.serverProfile.registrationMode,
        authorizationEndpoint: system.serverProfile.authorizationEndpoint ?? "",
        tokenEndpoint: system.serverProfile.tokenEndpoint ?? "",
        registrationEndpoint: system.serverProfile.registrationEndpoint ?? "",
        notes: system.serverProfile.notes,
      }),
  ...(system.clientProfile === null
    ? {}
    : {
        launchUrl: system.clientProfile.launchUrl,
        redirectUris: joinList(system.clientProfile.redirectUris),
        scopes: joinList(system.clientProfile.scopes),
        confidentiality: system.clientProfile.confidentiality,
        launchContext: system.clientProfile.launchContext,
        needsIntrospection: system.clientProfile.needsIntrospection,
      }),
});

/**
 * Assembles the request body the two contracts share.
 *
 * A profile the form does not claim is an explicit null rather than an omission,
 * because an omitted field leaves a stored profile alone and this is how a system
 * stops being a client.
 *
 * @param values - the form values
 * @returns the body, ready to parse against either contract
 */
const systemPayload = (values: SystemFormValues): unknown => ({
  name: values.name,
  description: values.description,
  serverProfile: values.isServer
    ? {
        fhirBaseUrl: values.fhirBaseUrl,
        authorizationMode: values.authorizationMode,
        registrationMode: values.registrationMode,
        // Each optional endpoint is omitted when blank rather than sent as an
        // empty string: what a member has not declared is not a declaration.
        ...(values.authorizationEndpoint.trim() === ""
          ? {}
          : { authorizationEndpoint: values.authorizationEndpoint.trim() }),
        ...(values.tokenEndpoint.trim() === ""
          ? {}
          : { tokenEndpoint: values.tokenEndpoint.trim() }),
        ...(values.registrationEndpoint.trim() === ""
          ? {}
          : { registrationEndpoint: values.registrationEndpoint.trim() }),
        notes: values.notes,
      }
    : null,
  clientProfile: values.isClient
    ? {
        launchUrl: values.launchUrl,
        redirectUris: splitList(values.redirectUris),
        scopes: splitList(values.scopes),
        confidentiality: values.confidentiality,
        launchContext: values.launchContext,
        needsIntrospection: values.needsIntrospection,
      }
    : null,
});

/**
 * Builds a creation request.
 *
 * @param values - the form values
 * @returns the request, or one issue per offending field
 * @example
 * ```ts
 * const outcome = buildSystemRequest(values);
 * if (outcome.ok) {
 *   await api.post(`/api/organisations/${id}/systems`, outcome.value, systemResponseSchema);
 * }
 * ```
 */
export const buildSystemRequest = (
  values: SystemFormValues,
): ParseOutcome<CreateSystemRequest> =>
  values.isServer || values.isClient
    ? parseRequest(createSystemRequestSchema, systemPayload(values))
    : { ok: false, issues: noKindChosen };

/**
 * Builds an edit.
 *
 * @param values - the form values
 * @returns the patch, or one issue per offending field
 * @example
 * ```ts
 * const outcome = buildSystemPatch(values);
 * ```
 */
export const buildSystemPatch = (
  values: SystemFormValues,
): ParseOutcome<UpdateSystemRequest> =>
  values.isServer || values.isClient
    ? parseRequest(updateSystemRequestSchema, systemPayload(values))
    : { ok: false, issues: noKindChosen };
