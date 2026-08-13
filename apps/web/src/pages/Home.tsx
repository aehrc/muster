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
    <article className="page">
      <h1>Muster</h1>
      <p className="lede">
        The connectathon participant directory: who is bringing which system to
        which event, what those systems can do, and whether they are actually
        reachable.
      </p>

      <h2>Without an account</h2>
      <ul>
        <li>
          <Link to={ROUTES.events}>Events</Link> - the systems enrolled in each
          event, with their connection details and verification status.
        </li>
        <li>
          <Link to={ROUTES.personas}>Personas</Link> - the shared test patients
          and which servers hold them.
        </li>
        <li>
          <Link to={ROUTES.docs}>Docs</Link> - the registration and permission
          ticket profiles a vendor implements.
        </li>
      </ul>

      <h2>With an approved account</h2>
      <p>
        Describe the systems your organisation brings, enrol them in an event,
        and drive a pairing from request to issued client identifier.{" "}
        <Link to={ROUTES.signIn}>Sign in or sign up</Link>.
      </p>
    </article>
  );
}
