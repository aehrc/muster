import { useCallback, useEffect, useState } from "react";

import { muster } from "./muster.ts";
import { failed, idle, pending } from "../lib/operation.ts";

import type { ResponseParser } from "./client.ts";
import type { Operation } from "../lib/operation.ts";

/**
 * Reading a resource from Muster's API, with its state visible throughout.
 *
 * A read reports itself while it is in flight and when it is refused; a read
 * that succeeded reports itself by rendering what it fetched, so the operation
 * returns to idle rather than leaving "loading succeeded" on the screen (FR-037
 * is about telling the person what happened, not about congratulating the
 * console).
 *
 * The parser must be a stable value - a schema declared at module scope - because
 * it is a dependency of the fetch. An inline schema would refetch forever.
 *
 * @author John Grimes
 */

/** A resource being read. */
export type Resource<Output> = {
  /** what was read, or null until something has been */
  readonly data: Output | null;
  /** the state of the read */
  readonly operation: Operation;
  /** reads it again */
  readonly reload: () => void;
};

/**
 * Reads a resource, and reads it again on demand.
 *
 * @param path - the path to read, or null to read nothing yet
 * @param parser - the contract schema the answer must satisfy; must be stable
 * @param what - the read, as a present-participle phrase, for the pending and
 *   failed messages
 * @returns the resource, its state, and a way to read it again
 * @example
 * ```ts
 * const { data, operation, reload } = useResource(
 *   `/api/events/${slug}/systems`,
 *   eventSystemsSchema,
 *   "Loading the event",
 * );
 * ```
 */
export const useResource = <Output>(
  path: string | null,
  parser: ResponseParser<Output>,
  what: string,
): Resource<Output> => {
  const [state, setState] = useState<{
    /** what was read */
    data: Output | null;
    /** the state of the read */
    operation: Operation;
  }>({ data: null, operation: idle });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (path === null) {
      setState({ data: null, operation: idle });
      return undefined;
    }
    let current = true;
    // The previous answer stays on screen while the next one is fetched, so a
    // reload does not blank the page it is refreshing.
    setState((previous) => ({ data: previous.data, operation: pending(what) }));
    void muster.get(path, parser).then((result) => {
      if (!current) {
        return;
      }
      setState(
        result.ok
          ? { data: result.data, operation: idle }
          : { data: null, operation: failed(what, result.failure) },
      );
    });
    return () => {
      current = false;
    };
  }, [path, parser, what, attempt]);

  const reload = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  return { data: state.data, operation: state.operation, reload };
};
