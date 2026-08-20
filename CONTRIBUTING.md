# Contributing to Muster

Muster is the connectathon participant directory. Contributions are welcome -
this document says how to get a change in.

## Code of conduct

This project adheres to the [Contributor Covenant Code of
Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this
code. Please report unacceptable behaviour to John.Grimes@csiro.au.

## How to contribute

### Reporting bugs

Check the existing issues first to avoid duplicates. A useful bug report
includes:

- a clear, descriptive title;
- steps to reproduce;
- the expected behaviour and what happened instead;
- the environment (operating system, Bun version, PostgreSQL version);
- the relevant log output. Muster logs a refusal with its cause, so that line is
  usually the whole story.

### Suggesting enhancements

Say what the change would do and why it is worth doing, and note the
alternatives you considered. Muster deliberately has few moving parts; a
proposal that adds a component needs to say what it buys.

### Pull requests

1. Fork the repository and branch from `main`.
2. Write the tests first (see Testing below), then the implementation.
3. Run every gate in Testing below; all of them pass before a change is done.
4. Follow the conventions already in the file you are editing.
5. Write commit messages in the imperative mood, one atomic change per commit.
6. Open the pull request as a draft and reference the issue it addresses.

## Development setup

Requirements: [Bun](https://bun.com) 1.3 or later, PostgreSQL 18, and
[overmind](https://github.com/DarthSim/overmind) (`brew install overmind`,
which needs `tmux`). Docker is needed only for the end-to-end suite and for
building the image.

```sh
bun install
bun run dev:setup       # creates the muster role, muster and muster_test databases
cp .env.example .env
bun run dev             # Muster, the console, and the three stub servers
bun run dev:seed        # in a second terminal: an admin account and an open event
```

The console is then at <http://localhost:5173>. See the README's "Getting
started" for the seeded credentials and how mail is handled locally.

## Coding standards

The repository's `CLAUDE.md` holds the constitution, and it is binding on
contributions. In short:

- **Pure core.** Domain logic lives in `packages/core` and performs no I/O.
  Time, randomness and fetching arrive as arguments. A rule expressible as a
  pure function does not go in a route handler.
- **Deny by default.** Every vouching action - minting a software statement,
  directory-initiated registration, minting a permission ticket - is refused
  unless every precondition is affirmatively true. Absent or ambiguous input is
  a refusal, never a default.
- **One path to the network.** `apps/server/src/outbound/outboundFetch.ts` is
  the only code that may reach a participant-supplied address. Nothing else
  calls `fetch` on one.
- **No stored client secrets.** A secret returned by a server is shown once and
  never persisted or logged. Passwords are argon2id hashes, session tokens are
  stored as hashes, and signing keys are encrypted at rest.
- **Single instance.** Scheduled work runs on an in-process interval, so the
  Helm chart pins `replicas: 1`. Do not add a second replica without replacing
  the scheduler.

TypeScript throughout, in a functional style: plain functions, closures and
immutable data, no `class`. Exported functions carry JSDoc. Files are named in
lower camel case, except React components, which are Pascal case. Formatting is
Prettier with its defaults; do not hand-format.

New files carry the Apache 2.0 header and an `@author` tag. Add yourself as an
author to a file you change substantially.

## Testing

Test-driven development is the rule here: write the tests that define the
behaviour, watch them fail, then implement.

Every one of these passes before a change is done:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run lint:duplication   # jscpd, threshold 0
bun run test               # unit + integration
bun run test:coverage      # >=80% lines and functions
bun run build && bun run check:bundle
```

The integration suites read `MUSTER_TEST_DATABASE_URL`, which `.env` already
sets; without it they skip visibly rather than failing. CI also sets
`MUSTER_REQUIRE_DATABASE_TESTS=1`, which turns a missing URL into a failure, so
they cannot go quiet.

The end-to-end suite runs against the Docker stack rather than the dev stack:

```sh
bun run stack:up && bun run stack:seed
bunx playwright install chromium
bun run test:e2e
bun run stack:down   # removes it all, database included
```

## Licence

By contributing to Muster, you agree that your contributions will be licensed
under the Apache License, Version 2.0.
