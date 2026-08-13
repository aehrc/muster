/**
 * Signing in, creating an account, and the states in between.
 *
 * The wireframe's two tabs, plus the two things that happen after signing up: the "check your
 * email" state and the "awaiting approval" card. Both are shown here rather than on a separate page
 * because they are the same question - "what do I do next?" - and the answer depends on the account
 * Muster reports, not on which page the browser is on.
 *
 * Every refusal is shown in the server's own words. That matters most for the rate limit: the
 * server says how long to wait, and a console that invented its own message would say something
 * different (FR-035, FR-037).
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { describeError } from "../api/errors.js";
import { useCredentialAction, useMe } from "../api/queries.js";
import { SubmitButton, TextField } from "../components/fields.js";
import {
  ErrorAlert,
  InfoAlert,
  PageHeader,
  Panel,
} from "../components/layout.js";
import { ROUTES } from "../routes.js";

import type { SessionAccount } from "@muster/contracts";

/** Which half of the card is showing. */
type Tab = "sign-in" | "sign-up";

/** The credential card, and where the caller stands. */
export function SignIn() {
  const me = useMe();
  const action = useCredentialAction();
  const [tab, setTab] = useState<Tab>("sign-in");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  // A sign-up establishes no session, so `me` still reports nobody afterwards. The account
  // the sign-up returned is what says "check your email" - without it, a successful sign-up
  // renders the empty form again and tells the person nothing (FR-037).
  const submitted =
    action.isSuccess && action.variables?.kind === "sign-up"
      ? action.data
      : undefined;
  const account = me.data?.account ?? submitted?.account ?? null;

  /** Signs in or signs up, depending on which tab is showing. */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    action.mutate(
      tab === "sign-in"
        ? { kind: "sign-in", email, password }
        : { kind: "sign-up", email, displayName, password },
    );
  };

  if (account !== null) {
    return (
      <Standing
        account={account}
        onResend={() => {
          action.mutate({ kind: "resend", email: account.email });
        }}
        resent={action.isSuccess && action.variables?.kind === "resend"}
      />
    );
  }

  return (
    <article className="page">
      <PageHeader
        title={tab === "sign-in" ? "Sign in" : "Create an account"}
        subtitle="Reading the directory needs no account. Describing a system, enrolling it or answering a pairing does."
      />

      <Panel title="Muster account">
        <div className="tabs">
          <button
            type="button"
            className={tab === "sign-in" ? "tab tab-on" : "tab"}
            aria-pressed={tab === "sign-in"}
            onClick={() => {
              setTab("sign-in");
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={tab === "sign-up" ? "tab tab-on" : "tab"}
            aria-pressed={tab === "sign-up"}
            onClick={() => {
              setTab("sign-up");
            }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
          />
          {tab === "sign-up" ? (
            <TextField
              label="Your name"
              value={displayName}
              onChange={setDisplayName}
              autoComplete="name"
              hint="Shown to other approved members beside your address."
              required
            />
          ) : null}
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={
              tab === "sign-in" ? "current-password" : "new-password"
            }
            {...(tab === "sign-up"
              ? { hint: "At least twelve characters. Length is the only rule." }
              : {})}
            required
          />
          <SubmitButton pending={action.isPending}>
            {tab === "sign-in" ? "Sign in" : "Create account"}
          </SubmitButton>
        </form>

        {action.error === null ? null : (
          <ErrorAlert message={describeError(action.error)} />
        )}
        <p className="note">
          Both forms are rate limited by client address. Repeated failures show
          a retry-after message rather than saying whether the account exists.
        </p>
      </Panel>
    </article>
  );
}

/** Where a signed-in account stands, and what to do about it. */
function Standing({
  account,
  onResend,
  resent,
}: Readonly<{
  readonly account: SessionAccount;
  readonly onResend: () => void;
  readonly resent: boolean;
}>) {
  if (!account.emailVerified) {
    return (
      <article className="page">
        <PageHeader
          title="Check your email"
          subtitle={`A verification link is on its way to ${account.email}.`}
        />
        <Panel title="Verify your address">
          <p>
            The link works once and expires after 24 hours. Follow it, and your
            account then waits for a track admin to approve it.
          </p>
          <button type="button" className="button" onClick={onResend}>
            Send another link
          </button>
          {resent ? <InfoAlert>Another link is on its way.</InfoAlert> : null}
        </Panel>
      </article>
    );
  }

  if (account.status === "pending") {
    return (
      <article className="page">
        <PageHeader title="Awaiting approval" status="pending" />
        <Panel title="Awaiting approval">
          <p>
            Your email is verified. Your account is awaiting approval by a track
            admin - you will be emailed when approved. Membership is standing
            once granted: it carries across events.
          </p>
          <p>
            In the meantime, everything on the{" "}
            <Link to={ROUTES.events}>event pages</Link> is readable.
          </p>
        </Panel>
      </article>
    );
  }

  if (account.status === "revoked") {
    return (
      <article className="page">
        <PageHeader title="Membership revoked" status="revoked" />
        <Panel title="Membership revoked">
          <p>
            A track admin has revoked this membership. The directory is still
            readable - all of it is public - but entries can no longer be
            created or edited from this account.
          </p>
        </Panel>
      </article>
    );
  }

  return (
    <article className="page">
      <PageHeader
        title={`Signed in as ${account.displayName}`}
        subtitle={account.email}
      />
      <Panel title="What you can do">
        <p>
          Describe the systems your organisation brings and enrol them in an
          event from <Link to={ROUTES.myOrganisation}>My organisation</Link>.
        </p>
        {account.isAdmin ? (
          <p>
            You are a track admin:{" "}
            <Link to={ROUTES.adminMembers}>approve members</Link> and{" "}
            <Link to={ROUTES.adminEvents}>manage events</Link>.
          </p>
        ) : null}
      </Panel>
    </article>
  );
}
