#!/bin/sh
# Creates the non-owning role the local stack's Muster serves with.
#
# The two-identity split (see `packages/db/src/roles.ts`) means the server connects as a role
# that cannot issue DDL. `node dist/index.js migrate` grants that role its access but does not
# create it - it holds no authority to create a role and no password to give one - so the role
# has to exist before the migration runs.
#
# This runs from the Postgres image's `docker-entrypoint-initdb.d`, which means it runs exactly
# once, when the cluster is initialised, as the superuser the image sets up. A stack whose volume
# already exists has the role already.
#
# The credentials are in the repository on purpose: they name a login on a throwaway database
# that exists for the duration of a development stack. A real deployment reads its own from a
# secret and never runs this file.
#
# Author: John Grimes

set -eu

psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'muster_app') then
    create role muster_app login password 'muster_app';
  end if;
end
$$;
SQL

echo "created the muster_app serving role"
