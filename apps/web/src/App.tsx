import { OrganizationIcon } from "@primer/octicons-react";

import type { JSX } from "react";

/**
 * Application shell.
 *
 * The setup phase ships the theming and build wiring only; the foundational
 * phase replaces this with the router, API client and public layout.
 *
 * @returns the application shell element
 * @author John Grimes
 */
export function App(): JSX.Element {
  return (
    <main className="hero min-h-screen bg-base-200">
      <div className="hero-content text-center">
        <div className="max-w-md">
          <OrganizationIcon size={32} />
          <h1 className="text-4xl font-bold">Muster</h1>
          <p className="py-4">Connectathon participant directory.</p>
        </div>
      </div>
    </main>
  );
}
