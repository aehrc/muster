import { LockIcon, MailIcon, PersonIcon } from "@primer/octicons-react";
import { Link } from "react-router";

import { contactsWithheld } from "../lib/directory.ts";

import type { EnrolledSystem } from "@muster/contracts";
import type { JSX } from "react";

/**
 * An organisation's contact details, or the reason they are not shown.
 *
 * Contact details never reach an anonymous reader (FR-007), and the server
 * enforces that by not looking them up at all. What the console adds is the
 * explanation: a reader who cannot see them is told that signing in is what shows
 * them, rather than being left to conclude the organisation has no contacts.
 *
 * @author John Grimes
 */

/**
 * Renders an organisation's contacts, or why they are withheld.
 *
 * @param props - the enrolled system whose organisation's contacts to show
 * @returns the contacts, or the explanation
 * @example
 * ```tsx
 * <Contacts entry={entry} />
 * ```
 */
export function Contacts({
  entry,
}: Readonly<{
  /** the enrolled system whose organisation's contacts to show */
  entry: EnrolledSystem;
}>): JSX.Element {
  if (contactsWithheld(entry)) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
        <LockIcon size={16} />
        <span>Contact details are shown to signed-in approved members.</span>
        <Link to="/sign-in" className="link link-primary">
          Sign in
        </Link>
      </p>
    );
  }

  const contacts = entry.contacts ?? [];
  if (contacts.length === 0) {
    return (
      <p className="text-sm text-base-content/70">
        This organisation has no members to contact. A track admin can reassign
        it.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {contacts.map((contact) => (
        <li
          key={contact.accountId}
          className="flex flex-wrap items-center gap-2"
        >
          <PersonIcon size={16} />
          <span>{contact.displayName}</span>
          <a
            className="link link-accent inline-flex items-center gap-1 font-mono text-xs"
            href={`mailto:${contact.email}`}
          >
            <MailIcon size={14} />
            {contact.email}
          </a>
        </li>
      ))}
    </ul>
  );
}
