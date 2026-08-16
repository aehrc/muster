/**
 * The landing page.
 *
 * States what Muster is and points at the public surfaces, because the first thing a
 * participant arriving from a Confluence link needs is to recognise that this is the
 * replacement for the table they were reading.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import { ROUTES } from "../routes.js";

/** What Muster is, and where to go next. */
export function Home() {
  return (
    <article className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold">Muster</h1>
        <p className="text-base-content/70 mt-2 text-lg">
          The connectathon participant directory: who is bringing which system
          to which event, what those systems can do, and whether they are
          actually reachable.
        </p>
      </div>

      <section>
        <h2 className="text-base-content/60 text-sm font-semibold tracking-wide uppercase">
          Without an account
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-2 pl-5">
          <li>
            <Link className="link" to={ROUTES.events}>
              Events
            </Link>{" "}
            - the systems enrolled in each event, with their connection details
            and verification status.
          </li>
          <li>
            <Link className="link" to={ROUTES.personas}>
              Personas
            </Link>{" "}
            - the shared test patients and which servers hold them.
          </li>
          <li>
            <Link className="link" to={ROUTES.docs}>
              Docs
            </Link>{" "}
            - the registration and permission ticket profiles a vendor
            implements.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-base-content/60 text-sm font-semibold tracking-wide uppercase">
          With an approved account
        </h2>
        <p className="mt-2">
          Describe the systems your organisation brings, enrol them in an event,
          and drive a pairing from request to issued client identifier.{" "}
          <Link className="link" to={ROUTES.signIn}>
            Sign in or sign up
          </Link>
          .
        </p>
      </section>
    </article>
  );
}
