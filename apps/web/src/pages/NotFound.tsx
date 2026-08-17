import { AlertIcon, ArrowLeftIcon } from "@primer/octicons-react";
import { Link, useLocation } from "react-router";

import type { JSX } from "react";

/**
 * Shown when no route matches, naming the address that did not resolve so a
 * mistyped or stale link is obvious rather than merely broken.
 *
 * @returns the not-found page
 * @author John Grimes
 */
export function NotFound(): JSX.Element {
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col items-start gap-4">
      <div role="alert" className="alert alert-warning">
        <AlertIcon size={20} />
        <span>
          There is nothing at <code className="font-mono">{pathname}</code>.
        </span>
      </div>
      <Link to="/" className="btn btn-primary btn-sm gap-2">
        <ArrowLeftIcon size={16} />
        Back to the directory
      </Link>
    </div>
  );
}
