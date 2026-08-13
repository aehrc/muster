/**
 * What an admin page shows somebody who is not one.
 *
 * A UI courtesy, not a control: the server refuses every admin route regardless, and this exists so
 * that a member who followed a link sees an explanation rather than a page of buttons that all fail.
 *
 * Shared by both admin pages, so the explanation cannot differ between them.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import { EmptyState, PageHeader } from "../../components/layout.js";
import { ROUTES } from "../../routes.js";

/** The stand-in an admin page renders when the caller is not a track admin. */
export function AdminOnly({ title }: Readonly<{ readonly title: string }>) {
  return (
    <article className="page">
      <PageHeader title={title} />
      <EmptyState>
        This page is for track admins. <Link to={ROUTES.signIn}>Sign in</Link>{" "}
        as one to use it.
      </EmptyState>
    </article>
  );
}
