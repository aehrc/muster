import {
  accountResponseSchema,
  resendVerificationRequestSchema,
  resendVerificationResponseSchema,
  sessionViewSchema,
  signInRequestSchema,
  signUpRequestSchema,
} from "@muster/contracts";
import {
  MailIcon,
  PersonAddIcon,
  ShieldCheckIcon,
  SignInIcon,
  SignOutIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";

import { muster } from "../api/muster.ts";
import { TextField } from "../components/Fields.tsx";
import { IssueList } from "../components/IssueList.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { standingFor } from "../lib/account.ts";
import { parseRequest } from "../lib/forms.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import { useSession } from "../session/sessionContext.ts";

import type { Operation } from "../lib/operation.ts";
import type { JSX } from "react";

/**
 * Signing up, verifying an address, signing in, and the pending-approval state.
 *
 * The three steps of acceptance scenario 1 are all here, because they are one
 * story from the participant's side: sign up, prove the address, wait for a track
 * admin. Each reports its own state, and the wait itself is a state the screen
 * names rather than a blank page with nothing on it.
 *
 * The verification link in the email lands on this route carrying its token, so
 * arriving with `?token=` spends it and reports what happened - including the two
 * edge cases the specification calls out, a link used twice and a link used late,
 * both of which the server answers with wording fit to show.
 *
 * Those two refusals are the reason for the resend panel below them, and for the
 * button in the signed-in unverified state: a token lives a day, so without an
 * offer that works, an account whose link lapsed would be stranded. Anonymously
 * the address is typed, because the token says nothing about whose it was; signed
 * in, the account's own address is used.
 *
 * @author John Grimes
 */

/** The answer to signing out. */
const signOutResponseSchema = z.object({ signedOut: z.boolean() });

/** What signing in is called in its messages. */
const signingIn = "Signing in";

/** What signing up is called in its messages. */
const signingUp = "Creating your account";

/** What verifying is called in its messages. */
const verifying = "Verifying your address";

/** What asking for a replacement link is called in its messages. */
const resending = "Sending a new verification link";

/**
 * What the console says about a resend, whatever the address turned out to be.
 *
 * The server answers every caller identically so that nobody can learn which
 * addresses hold accounts from it, and the console does not pretend to know more
 * than it was told: the sentence is true of an unknown address, of one already
 * verified, and of one whose link had lapsed.
 *
 * @param email - the address the link was asked for
 * @returns the sentence to show
 */
const resentMessage = (email: string): string =>
  `If ${email} has an account whose address still needs verifying, a new link is on its way. It replaces any earlier link and expires within a day.`;

/**
 * The sign-in and sign-up screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function SignIn(): JSX.Element {
  const { session, operation: sessionOperation, adopt, refresh } = useSession();
  const [parameters, setParameters] = useSearchParams();
  const token = parameters.get("token");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  // The link in the verification email lands here with its token. Spending it is
  // the whole purpose of the visit, so it happens on arrival rather than behind
  // a button, and the token is dropped from the address once spent so a reload
  // does not report it as already used.
  //
  // A verification token is single use, which makes spending it the one effect
  // here that must not run twice for one arrival. React deliberately mounts twice
  // in development, and a remount would otherwise spend the token again and
  // report the member's successful verification as "already used" - so each token
  // is recorded as it is spent and skipped if the effect runs again.
  const spent = useRef<string | null>(null);
  useEffect(() => {
    if (token === null || spent.current === token) {
      return;
    }
    spent.current = token;
    setOperation(pending(verifying));
    void muster
      .post("/api/auth/verify", { token }, accountResponseSchema)
      .then((result) => {
        setOperation(
          result.ok
            ? succeeded(
                verifying,
                "Your address is verified. A track admin approves accounts before they can create anything; you can sign in now and watch for that.",
              )
            : failed(verifying, result.failure),
        );
        setParameters(new URLSearchParams(), { replace: true });
        refresh();
      });
  }, [token, setParameters, refresh]);

  // The offer behind the refusal a spent or lapsed link is answered with. Asked
  // for by address, because whoever needs it is usually not signed in - they
  // followed a link out of a mail client - and a signed-in account with an
  // unverified address has its own address filled in for it.
  const handleResend = async (recipient: string): Promise<void> => {
    const outcome = parseRequest(resendVerificationRequestSchema, {
      email: recipient,
    });
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(resending));
    const result = await muster.post(
      "/api/auth/resend-verification",
      outcome.value,
      resendVerificationResponseSchema,
    );
    setOperation(
      result.ok
        ? succeeded(resending, resentMessage(outcome.value.email))
        : failed(resending, result.failure),
    );
  };

  const handleSignIn = async (): Promise<void> => {
    const outcome = parseRequest(signInRequestSchema, { email, password });
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(signingIn));
    const result = await muster.post(
      "/api/auth/sign-in",
      outcome.value,
      sessionViewSchema,
    );
    if (result.ok) {
      adopt(result.data);
      setPassword("");
      setOperation(
        succeeded(
          signingIn,
          `Signed in as ${result.data.account.displayName}.`,
        ),
      );
      return;
    }
    setOperation(failed(signingIn, result.failure));
  };

  const handleSignUp = async (): Promise<void> => {
    const outcome = parseRequest(signUpRequestSchema, {
      email,
      displayName,
      password,
    });
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(signingUp));
    const result = await muster.post(
      "/api/auth/sign-up",
      outcome.value,
      accountResponseSchema,
    );
    setOperation(
      result.ok
        ? succeeded(
            signingUp,
            `Account created for ${result.data.account.email}. Open the verification link Muster has emailed to that address; the account cannot create anything until the address is verified and a track admin approves it.`,
          )
        : failed(signingUp, result.failure),
    );
  };

  const handleSignOut = async (): Promise<void> => {
    setOperation(pending("Signing out"));
    const result = await muster.post(
      "/api/auth/sign-out",
      {},
      signOutResponseSchema,
    );
    if (result.ok) {
      adopt(null);
      setOperation(succeeded("Signing out", "Signed out."));
      return;
    }
    setOperation(failed("Signing out", result.failure));
  };

  const standing = standingFor(session);
  const working = busy(operation) || busy(sessionOperation);

  if (session !== null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold sm:text-3xl">Your account</h1>
        <OperationAlert operation={operation} />
        <OperationAlert operation={sessionOperation} />

        <Panel
          title={standing.headline}
          icon={<ShieldCheckIcon size={18} />}
          description={standing.detail}
        >
          <dl className="flex flex-col gap-2 text-sm sm:grid sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-x-4">
            <dt className="text-base-content/60">Name</dt>
            <dd>{session.account.displayName}</dd>
            <dt className="text-base-content/60">Address</dt>
            <dd className="font-mono text-xs">{session.account.email}</dd>
            <dt className="text-base-content/60">Status</dt>
            <dd>
              <span className="badge badge-soft badge-sm">
                {session.account.status}
              </span>{" "}
              <span className="badge badge-soft badge-sm">
                {session.account.emailVerified
                  ? "address verified"
                  : "address not verified"}
              </span>
              {session.account.isAdmin ? (
                <span className="badge badge-soft badge-primary badge-sm">
                  track admin
                </span>
              ) : null}
            </dd>
            <dt className="text-base-content/60">Organisations</dt>
            <dd>
              {session.memberships.length === 0
                ? "None yet."
                : session.memberships
                    .map((membership) => membership.name)
                    .join(", ")}
            </dd>
          </dl>

          <div className="flex flex-wrap gap-2">
            {standing.canWrite ? (
              <Link to="/my-organisation" className="btn btn-primary btn-sm">
                My organisation
              </Link>
            ) : null}
            {session.account.emailVerified ? null : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={working}
                onClick={() => {
                  void handleResend(session.account.email);
                }}
              >
                <MailIcon size={16} />
                Send a new verification link
              </button>
            )}
            <button
              type="button"
              className="btn btn-error btn-sm"
              disabled={working}
              onClick={() => {
                void handleSignOut();
              }}
            >
              <SignOutIcon size={16} />
              Sign out
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={working}
              onClick={refresh}
            >
              <SyncIcon size={16} />
              Check again
            </button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold sm:text-3xl">Sign in to Muster</h1>
      <p className="max-w-2xl text-base-content/80">
        The directory is readable without an account. Signing in shows you
        contact details and lets you describe and enrol your organisation&apos;s
        systems.
      </p>

      <OperationAlert operation={operation} />
      <IssueList issues={issues} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex-1">
          <Panel title="Sign in" icon={<SignInIcon size={18} />}>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSignIn();
              }}
            >
              <TextField
                label="Email address"
                type="email"
                autoComplete="username"
                value={email}
                onChange={setEmail}
                required
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                required
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm self-start"
                disabled={working}
              >
                <SignInIcon size={16} />
                Sign in
              </button>
            </form>
          </Panel>
        </div>

        <div className="flex-1">
          <Panel
            title="Create an account"
            icon={<PersonAddIcon size={18} />}
            description="Muster emails a link to prove the address is yours. A track admin then approves the account, which is a standing membership that persists across events."
          >
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSignUp();
              }}
            >
              <TextField
                label="Email address"
                type="email"
                autoComplete="email"
                value={email}
                onChange={setEmail}
                required
              />
              <TextField
                label="Your name"
                hint="Shown to the other members of your organisations."
                value={displayName}
                onChange={setDisplayName}
                required
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="new-password"
                hint="At least 12 characters. A passphrase is the intended shape."
                value={password}
                onChange={setPassword}
                required
              />
              <button
                type="submit"
                className="btn btn-sm self-start"
                disabled={working}
              >
                <MailIcon size={16} />
                Create account
              </button>
            </form>
          </Panel>
        </div>
      </div>

      <Panel
        title="Send a new verification link"
        icon={<MailIcon size={18} />}
        description="Verification links arrive by email and land back on this page. A link works once and expires within a day; if yours says it has already been used or has expired, ask for a replacement here. The new link supersedes the old one."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleResend(email);
          }}
        >
          <TextField
            label="Email address"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            required
          />
          <button
            type="submit"
            className="btn btn-sm self-start"
            disabled={working}
          >
            <MailIcon size={16} />
            Send a new link
          </button>
        </form>
      </Panel>
    </div>
  );
}
