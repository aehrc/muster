/**
 * What an address the console does not serve looks like.
 *
 * A page rather than a redirect: sending a mistyped URL to the landing page hides the
 * mistake, and a reader who followed a stale link should be told the link is stale.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import { ROUTES } from "../routes.js";

/** The console's 404. */
export function NotFound() {
  return (
    <article className="mx-auto flex w-full max-w-md flex-col gap-2">
      <h1 className="text-2xl font-semibold">No page at this address</h1>
      <p>
        The link may be out of date.{" "}
        <Link className="link" to={ROUTES.home}>
          Start again
        </Link>
        .
      </p>
    </article>
  );
}
