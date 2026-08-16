/**
 * Where a verification link lands.
 *
 * The link in the email is `${MUSTER_PUBLIC_URL}/verify?token=…`, so this page's job is to redeem
 * the token and say what happened. Three outcomes, and the third is the one the spec calls out:
 * a link used twice or followed too late fails with a clear message and an offer to resend.
 *
 * The token is redeemed on a button press rather than on load. A verification link that acted as
 * soon as it was opened would be redeemed by any mail client that prefetches links, and the holder
 * would arrive at a page saying their link had already been used.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { describeError } from "../api/errors.js";
import { useCredentialAction } from "../api/queries.js";
import { SubmitButton, TextField } from "../components/fields.js";
import {
  ErrorAlert,
  InfoAlert,
  PageHeader,
  Panel,
} from "../components/layout.js";
import { ROUTES } from "../routes.js";

/** Redeems a verification token, and offers a resend when it will not work. */
export function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const action = useCredentialAction();
  const [email, setEmail] = useState("");

  const verified = action.isSuccess && action.variables?.kind === "verify";
  const resent = action.isSuccess && action.variables?.kind === "resend";

  if (verified) {
    return (
      <article className="flex flex-col">
        <PageHeader
          title="Address verified"
          subtitle="Your account is now awaiting approval by a track admin."
        />
        <Panel title="What happens next">
          <p>
            You will be emailed when a track admin approves the account. Until
            then, everything on the{" "}
            <Link className="link" to={ROUTES.events}>
              event pages
            </Link>{" "}
            is readable, and{" "}
            <Link className="link" to={ROUTES.signIn}>
              signing in
            </Link>{" "}
            will show where you stand.
          </p>
        </Panel>
      </article>
    );
  }

  return (
    <article className="flex flex-col">
      <PageHeader
        title="Verify your address"
        subtitle="Confirming this address finishes creating your Muster account."
      />

      <Panel title="Redeem the link">
        {token.length === 0 ? (
          <p>
            This page needs the link from the verification email. Open the link
            rather than this page.
          </p>
        ) : (
          <form
            className="flex flex-col items-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              action.mutate({ kind: "verify", token });
            }}
          >
            <p>
              The link works once and expires after 24 hours. Press to redeem
              it.
            </p>
            <SubmitButton pending={action.isPending}>
              Verify my address
            </SubmitButton>
          </form>
        )}
        {action.error === null ? null : (
          <ErrorAlert message={describeError(action.error)} />
        )}
      </Panel>

      <Panel
        title="Send another link"
        description="For a link that has expired or has already been used."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate({ kind: "resend", email });
          }}
        >
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
          />
          <SubmitButton pending={action.isPending}>
            Send another link
          </SubmitButton>
        </form>
        {resent ? (
          <InfoAlert>
            If that address has an unverified Muster account, a new link is on
            its way.
          </InfoAlert>
        ) : null}
      </Panel>
    </article>
  );
}
