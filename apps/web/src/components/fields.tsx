/**
 * The form controls.
 *
 * One component per kind of input, so that the label, the identifier tying it to its control
 * and the hint are wired the same way on every form. `useId` rather than a hand-written
 * identifier: two systems being edited on one page would otherwise share a `for` attribute,
 * and clicking one label would focus the other's input.
 *
 * The arrangement is the form wireframe's: label above the control, hint below it, one column,
 * and a single primary action at the end. Controls are daisyUI's, so they follow the theme
 * with everything else and carry its focus ring - which is the whole of FR-010 for a form.
 *
 * Author: John Grimes
 */

import { useId } from "react";

import type { ReactNode } from "react";

/** What every field has in common. */
interface FieldFrameProps {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string) => ReactNode;
}

/** A label, its control and an optional hint. */
function FieldFrame({ label, hint, children }: Readonly<FieldFrameProps>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="mb-4 flex w-full flex-col gap-1">
      <label className="text-sm font-semibold" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint === undefined ? null : (
        <p className="text-base-content/60 text-xs" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** A single-line text input. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  required,
  autoComplete,
}: Readonly<{
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "email" | "password" | "url" | "date" | "number";
  readonly placeholder?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly autoComplete?: string;
}>) {
  return (
    <FieldFrame label={label} {...(hint === undefined ? {} : { hint })}>
      {(id) => (
        <input
          id={id}
          className="input w-full"
          type={type}
          value={value}
          required={required ?? false}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      )}
    </FieldFrame>
  );
}

/** A multi-line text input. */
export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  rows = 3,
}: Readonly<{
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly rows?: number;
}>) {
  return (
    <FieldFrame label={label} {...(hint === undefined ? {} : { hint })}>
      {(id) => (
        <textarea
          id={id}
          className="textarea w-full"
          rows={rows}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      )}
    </FieldFrame>
  );
}

/** A choice from a closed set. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: Readonly<{
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly onChange: (value: string) => void;
  readonly hint?: string;
}>) {
  return (
    <FieldFrame label={label} {...(hint === undefined ? {} : { hint })}>
      {(id) => (
        <select
          id={id}
          className="select w-full"
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

/** A yes-or-no. */
export function CheckField({
  label,
  checked,
  onChange,
  hint,
}: Readonly<{
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string;
}>) {
  const id = useId();
  return (
    <div className="mb-4 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          className="checkbox checkbox-sm"
          type="checkbox"
          checked={checked}
          onChange={(event) => {
            onChange(event.currentTarget.checked);
          }}
        />
        <label className="cursor-pointer text-sm font-semibold" htmlFor={id}>
          {label}
        </label>
      </div>
      {hint === undefined ? null : (
        <p className="text-base-content/60 text-xs">{hint}</p>
      )}
    </div>
  );
}

/**
 * A submit button that says what it is doing.
 *
 * Disabled while the request is in flight, and it says so rather than looking idle: FR-037
 * asks every operation to report its state, and a button that looks unpressed while a request
 * is running invites a second one.
 */
export function SubmitButton({
  pending,
  children,
}: Readonly<{ readonly pending: boolean; readonly children: ReactNode }>) {
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}
