import { PlugIcon, PulseIcon, ServerIcon } from "@primer/octicons-react";

import type { JSX } from "react";

/**
 * The public landing page: what Muster is, and what a participant does with it.
 *
 * @returns the landing page
 * @author John Grimes
 */
export function Home(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold sm:text-4xl">
          The connectathon participant directory
        </h1>
        <p className="max-w-2xl text-base-content/80">
          Muster replaces the participant table. Organisations describe their
          systems once, enrol them into each event, and connect an app to a
          server without an email round trip.
        </p>
      </section>

      <section className="flex flex-col gap-4 sm:flex-row">
        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <ServerIcon size={20} />A standing registry
            </h2>
            <p className="text-sm text-base-content/80">
              Systems are servers, clients, or both, described with the fields a
              pairing actually needs. Enrolment carries a fresh confirmation
              that the details are current.
            </p>
          </div>
        </article>

        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <PlugIcon size={20} />
              Pairings, tracked
            </h2>
            <p className="text-sm text-base-content/80">
              A pairing request moves through explicit states, and both
              organisations see the same timeline. Servers that accept a signed
              software statement need no human at all.
            </p>
          </div>
        </article>

        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <PulseIcon size={20} />
              Checked, not assumed
            </h2>
            <p className="text-sm text-base-content/80">
              Enrolled servers are fetched on a schedule, and the directory
              shows what each one actually advertises, when it was last
              reachable, and where that drifts from what was declared.
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}
