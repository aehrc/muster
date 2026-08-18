import { useId } from "react";

import type { JSX, ReactNode } from "react";

/**
 * The form controls every screen in the console is built from.
 *
 * One definition each, so a label is attached to its control the same way
 * everywhere and no page repeats the class names. Each generates its own
 * identifier with `useId`, which is what makes the label programmatically
 * associated rather than merely adjacent.
 *
 * @author John Grimes
 */

/** What every field carries. */
type CommonFieldProps = {
  /** the visible label */
  readonly label: string;
  /** what the field is for, or how to fill it in */
  readonly hint?: string | undefined;
};

/** What a text field carries. */
type TextFieldProps = CommonFieldProps & {
  /** the current value */
  readonly value: string;
  /** called with the new value */
  readonly onChange: (value: string) => void;
  /** the input type */
  readonly type?: "text" | "email" | "password" | "date" | "url" | "number";
  /** an example, shown when the field is empty */
  readonly placeholder?: string | undefined;
  /** what a password manager should offer */
  readonly autoComplete?: string | undefined;
  /** whether the browser should insist on a value */
  readonly required?: boolean;
};

/** What a text area carries. */
type TextAreaFieldProps = CommonFieldProps & {
  /** the current value */
  readonly value: string;
  /** called with the new value */
  readonly onChange: (value: string) => void;
  /** how many rows to show */
  readonly rows?: number;
  /** an example, shown when the field is empty */
  readonly placeholder?: string | undefined;
};

/** One choice in a select. */
export type SelectOption = {
  /** the value submitted */
  readonly value: string;
  /** what the reader sees */
  readonly label: string;
};

/** What a select carries. */
type SelectFieldProps = CommonFieldProps & {
  /** the current value */
  readonly value: string;
  /** called with the new value */
  readonly onChange: (value: string) => void;
  /** the choices */
  readonly options: readonly SelectOption[];
};

/** What a checkbox carries. */
type CheckboxFieldProps = CommonFieldProps & {
  /** whether it is ticked */
  readonly checked: boolean;
  /** called with the new state */
  readonly onChange: (checked: boolean) => void;
};

/**
 * Wraps a control with its label and hint.
 *
 * @param props - the label, the hint, the control's identifier and the control
 * @returns the labelled control
 */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: Readonly<
  CommonFieldProps & {
    /** the identifier of the control being labelled */
    htmlFor: string;
    /** the control */
    children: ReactNode;
  }
>): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="label" htmlFor={htmlFor}>
        <span className="font-medium">{label}</span>
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-base-content/60">{hint}</p>
      )}
    </div>
  );
}

/**
 * A single-line text field.
 *
 * @param props - the label, the value, and what to do with a new one
 * @returns the field
 * @example
 * ```tsx
 * <TextField label="Email address" type="email" value={email} onChange={setEmail} />
 * ```
 */
export function TextField(props: Readonly<TextFieldProps>): JSX.Element {
  const id = useId();
  return (
    <Field label={props.label} hint={props.hint} htmlFor={id}>
      <input
        id={id}
        className="input w-full"
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        required={props.required ?? false}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      />
    </Field>
  );
}

/**
 * A multi-line text field.
 *
 * @param props - the label, the value, and what to do with a new one
 * @returns the field
 * @example
 * ```tsx
 * <TextAreaField label="Redirect URIs" value={uris} onChange={setUris} />
 * ```
 */
export function TextAreaField(
  props: Readonly<TextAreaFieldProps>,
): JSX.Element {
  const id = useId();
  return (
    <Field label={props.label} hint={props.hint} htmlFor={id}>
      <textarea
        id={id}
        className="textarea w-full font-mono text-xs"
        rows={props.rows ?? 3}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      />
    </Field>
  );
}

/**
 * A field with a fixed set of choices.
 *
 * @param props - the label, the choices, the value, and what to do with a new one
 * @returns the field
 * @example
 * ```tsx
 * <SelectField label="Registration mode" options={modes} value={mode} onChange={setMode} />
 * ```
 */
export function SelectField(props: Readonly<SelectFieldProps>): JSX.Element {
  const id = useId();
  return (
    <Field label={props.label} hint={props.hint} htmlFor={id}>
      <select
        id={id}
        className="select w-full"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * A field that is either ticked or not.
 *
 * @param props - the label, whether it is ticked, and what to do when it changes
 * @returns the field
 * @example
 * ```tsx
 * <CheckboxField label="This system is a server" checked={isServer} onChange={setIsServer} />
 * ```
 */
export function CheckboxField(
  props: Readonly<CheckboxFieldProps>,
): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="label cursor-pointer justify-start gap-2" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="checkbox"
          checked={props.checked}
          onChange={(event) => {
            props.onChange(event.currentTarget.checked);
          }}
        />
        <span className="font-medium">{props.label}</span>
      </label>
      {props.hint === undefined ? null : (
        <p className="text-xs text-base-content/60">{props.hint}</p>
      )}
    </div>
  );
}
