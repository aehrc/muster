/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  authorizationModeSchema,
  clientConfidentialitySchema,
  registrationModeSchema,
} from "@muster/contracts";
import { PlugIcon, ServerIcon } from "@primer/octicons-react";

import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
} from "./Fields.tsx";

import type { SystemFormValues } from "../lib/systemForm.ts";
import type { JSX } from "react";

/**
 * The system form: FR-006's field set, for creating one or editing one.
 *
 * One component for both, because a system's fields do not depend on whether it
 * already exists, and two forms would be two chances to leave a field out. The
 * halves appear only when the system claims that kind, so nobody fills in a FHIR
 * base URL for a system that is only a client.
 *
 * It holds no state and performs no calls: the values and the submit belong to the
 * screen using it, which is what lets the same form serve a create and an edit.
 *
 * @author John Grimes
 */

/** How a server authorises access. */
const authorizationOptions = [
  { value: "smart", label: "SMART on FHIR" },
  { value: "open", label: "Open (no authorization)" },
];

/** How a server registers clients. */
const registrationOptions = [
  { value: "manual", label: "Manual, by the server's owner" },
  { value: "trustedDcr", label: "Trusted dynamic client registration" },
  { value: "open", label: "None needed" },
];

/** Whether a client can keep a secret. */
const confidentialityOptions = [
  { value: "public", label: "Public (cannot keep a secret)" },
  { value: "confidential", label: "Confidential (keeps a secret)" },
];

/**
 * Renders the system form.
 *
 * @param props - the values, how to change them, and the submit button's label
 * @returns the form fields
 * @example
 * ```tsx
 * <SystemForm values={values} onChange={setValues} />
 * ```
 */
export function SystemForm({
  values,
  onChange,
}: Readonly<{
  /** the current values */
  values: SystemFormValues;
  /** called with the values after a change */
  onChange: (values: SystemFormValues) => void;
}>): JSX.Element {
  // One updater, so every field changes the values the same way and none of them
  // can drop the rest.
  const change = <Field extends keyof SystemFormValues>(
    field: Field,
    value: SystemFormValues[Field],
  ): void => {
    onChange({ ...values, [field]: value });
  };

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="Name"
        value={values.name}
        onChange={(value) => {
          change("name", value);
        }}
        required
      />
      <TextAreaField
        label="Description"
        hint="What the system is, in a sentence."
        rows={2}
        value={values.description}
        onChange={(value) => {
          change("description", value);
        }}
      />

      <fieldset className="fieldset rounded-box border border-base-300 p-4">
        <legend className="fieldset-legend">What is it?</legend>
        <CheckboxField
          label="A server"
          checked={values.isServer}
          onChange={(value) => {
            change("isServer", value);
          }}
        />
        <CheckboxField
          label="A client"
          checked={values.isClient}
          onChange={(value) => {
            change("isClient", value);
          }}
        />
        <p className="label">A system is a server, a client, or both.</p>
      </fieldset>

      {values.isServer ? (
        <fieldset className="fieldset flex flex-col gap-3 rounded-box border border-base-300 p-4">
          <legend className="fieldset-legend flex items-center gap-2">
            <ServerIcon size={16} />
            Server details
          </legend>
          <TextField
            label="FHIR base URL"
            type="url"
            placeholder="https://fhir.example.org"
            value={values.fhirBaseUrl}
            onChange={(value) => {
              change("fhirBaseUrl", value);
            }}
          />
          <SelectField
            label="Authorization mode"
            options={authorizationOptions}
            value={values.authorizationMode}
            onChange={(value) => {
              change("authorizationMode", authorizationModeSchema.parse(value));
            }}
          />
          <SelectField
            label="Registration mode"
            options={registrationOptions}
            value={values.registrationMode}
            onChange={(value) => {
              change("registrationMode", registrationModeSchema.parse(value));
            }}
          />
          <TextField
            label="Authorization endpoint"
            type="url"
            hint="What this server says it is. A check compares it with the server's own smart-configuration and flags a difference."
            placeholder="https://auth.example.org/authorize"
            value={values.authorizationEndpoint}
            onChange={(value) => {
              change("authorizationEndpoint", value);
            }}
          />
          <TextField
            label="Token endpoint"
            type="url"
            hint="As above: declaring it is what lets Muster tell you when it has moved."
            placeholder="https://auth.example.org/token"
            value={values.tokenEndpoint}
            onChange={(value) => {
              change("tokenEndpoint", value);
            }}
          />
          <TextField
            label="Registration endpoint"
            type="url"
            hint="Required for trusted dynamic client registration."
            placeholder="https://auth.example.org/register"
            value={values.registrationEndpoint}
            onChange={(value) => {
              change("registrationEndpoint", value);
            }}
          />
          <TextAreaField
            label="Notes"
            hint="Anything a person registering a client needs to know."
            rows={2}
            value={values.notes}
            onChange={(value) => {
              change("notes", value);
            }}
          />
        </fieldset>
      ) : null}

      {values.isClient ? (
        <fieldset className="fieldset flex flex-col gap-3 rounded-box border border-base-300 p-4">
          <legend className="fieldset-legend flex items-center gap-2">
            <PlugIcon size={16} />
            Client details
          </legend>
          <TextField
            label="Launch URL"
            type="url"
            placeholder="https://app.example.org/launch"
            value={values.launchUrl}
            onChange={(value) => {
              change("launchUrl", value);
            }}
          />
          <TextAreaField
            label="Redirect URIs"
            hint="One per line."
            value={values.redirectUris}
            onChange={(value) => {
              change("redirectUris", value);
            }}
          />
          <TextAreaField
            label="Scopes"
            hint="Separated by spaces, commas or newlines."
            rows={2}
            value={values.scopes}
            onChange={(value) => {
              change("scopes", value);
            }}
          />
          <SelectField
            label="Client type"
            options={confidentialityOptions}
            value={values.confidentiality}
            onChange={(value) => {
              change(
                "confidentiality",
                clientConfidentialitySchema.parse(value),
              );
            }}
          />
          <TextField
            label="Launch context"
            hint="The context the client needs at launch, such as patient or encounter."
            value={values.launchContext}
            onChange={(value) => {
              change("launchContext", value);
            }}
          />
          <CheckboxField
            label="Needs token introspection"
            checked={values.needsIntrospection}
            onChange={(value) => {
              change("needsIntrospection", value);
            }}
          />
        </fieldset>
      ) : null}
    </div>
  );
}
