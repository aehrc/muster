# Muster Helm chart

Deploys Muster, a connectathon participant directory: a persistent registry of
organisations and their systems, per-event enrolment, a pairing workflow with a
trusted dynamic client registration ceiling, live verification of server
entries, machine-readable exports, a conformance harness, shared personas and a
permission ticket playground.

## Features

- One Deployment, one Service, and a migration Job that runs before either.
- Replicas pinned to 1, because the verification and coverage schedulers run
  inside the server process. See "Why one replica" below.
- `existingSecret` references for the envelope key, both database identities and
  the SMTP relay, so no credential need ever appear in this chart's values.
- Refuses to render without `MUSTER_PUBLIC_URL`, which every public URL Muster
  emits derives from.
- The identity that owns the schema reaches the migration Job and nothing else.

## Prerequisites

- Kubernetes 1.25 or later, and Helm 3.
- PostgreSQL 16 or later, reachable from the cluster. The chart bundles no
  database.
- Two database identities and the Secrets holding them - see below.
- An SMTP relay. Without one Muster uses the console transport, which writes
  every message to the pod's log instead of delivering it, so no address can be
  verified and nobody but the seeded administrator can sign in.

## Before the first install

Muster runs as two database identities. The server serves with a role that owns
nothing and cannot issue DDL; migrations are DDL and are applied by the identity
that owns the schema. **The migration Job grants the serving role its access but
cannot create it** - it holds neither the authority to create a role nor a
password to give one - so the role has to exist first. An install against a
database where it does not fails at the migration Job with Postgres saying the
role does not exist.

Create both, once, as a superuser:

```sql
create role muster_owner login password '<owner password>';
create role muster_app login password '<serving password>';
create database muster owner muster_owner;
```

`deploy/postgres/init/10-serving-role.sh` in this repository is the same step
for the development stack, where the Postgres image runs it on first
initialisation.

Then the Secrets the chart references:

```bash
kubectl create secret generic muster-db \
  --from-literal=url="postgres://muster_app:<serving password>@db.example.org:5432/muster"

kubectl create secret generic muster-db-owner \
  --from-literal=ownerUrl="postgres://muster_owner:<owner password>@db.example.org:5432/muster"

kubectl create secret generic muster-master-key \
  --from-literal=masterKey="$(openssl rand -hex 32)"

kubectl create secret generic muster-smtp \
  --from-literal=url="smtp://user:password@smtp.example.org:587"
```

The master key encrypts signing private keys at rest. **Back it up.** If it is
lost, every stored signing key becomes undecryptable, and every software
statement and permission ticket already issued becomes unverifiable - which
breaks the promise that rotating a key does not invalidate outstanding
artefacts.

## Installation

```bash
helm install muster deploy/helm/muster -f deploy/helm/example-values.yaml
```

`deploy/helm/example-values.yaml` is a complete, working configuration of the
shape above; copy it and change the origin and the Secret names. It is what the
repository's `bun run check:chart` and the CI workflow render against, so it
cannot drift from the chart.

There is no way in over HTTP until the first administrator exists, and no route
can create one - a route that could would be the whole security model's single
point of failure. Seed it from the image:

```bash
kubectl run muster-seed --rm -it --restart=Never \
  --image=ghcr.io/csiro/muster:0.1.0 \
  --env=MUSTER_DATABASE_URL="postgres://muster_app:<serving password>@db.example.org:5432/muster" \
  --env=MUSTER_SEED_ADMIN_EMAIL="you@example.org" \
  --env=MUSTER_SEED_ADMIN_PASSWORD="<a password>" \
  --command -- bun dist/index.js seed
```

The seed is idempotent and never prints the password.

## Why one replica

Muster's scheduled work - the liveness and drift checks over every enrolled
server, and the persona coverage pass - runs on an in-process interval inside the
server (`apps/server/src/scheduler/scheduler.ts`). The project constitution
forbids queues, workers and background services, so there is nowhere else for it
to run and nothing that would coordinate one copy of it with another. A second
pod is a second scheduler: two passes arriving at the same participant's test
server at once, two rows written for one check, and a single-flight guard that
holds within a process and not across pods.

So `replicas` is not exposed as a value, the Deployment hardcodes `1`, and the
strategy is `Recreate` rather than `RollingUpdate` - a rolling update surges a
new pod before the old one goes away, which would run two schedulers for the
length of every rollout. The cost is a few seconds of downtime on upgrade.
`scripts/checkChart.mjs` asserts all three against the rendered output, and
asserts that no HorizontalPodAutoscaler is rendered.

## Configuration

| Parameter                                 | Description                                                                       | Default                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| `muster.image`                            | Container image                                                                   | `ghcr.io/csiro/muster:0.1.0`                        |
| `muster.imagePullPolicy`                  | Image pull policy                                                                 | `Always`                                            |
| `muster.imagePullSecrets`                 | Secrets for pulling the image                                                     | `[]`                                                |
| `muster.config`                           | Non-sensitive environment for the server, as a map of variable to value           | see below                                           |
| `muster.secretConfig`                     | Sensitive environment, written to a Secret and mounted with `envFrom`             | `{}`                                                |
| `muster.masterKey.existingSecret`         | Secret holding the envelope key. Unset generates one and keeps it across upgrades | `~`                                                 |
| `muster.masterKey.existingSecretKey`      | Key within that Secret                                                            | `masterKey`                                         |
| `muster.masterKey.value`                  | The envelope key as a literal. For evaluation only                                | `~`                                                 |
| `muster.database.existingSecret`          | Secret holding the serving connection                                             | `~`                                                 |
| `muster.database.existingSecretKey`       | Key within that Secret                                                            | `url`                                               |
| `muster.database.url`                     | The serving connection as a literal. For evaluation only                          | `~`                                                 |
| `muster.database.ownerExistingSecret`     | Secret holding the owning connection. Reaches the migration Job alone             | `~`                                                 |
| `muster.database.ownerExistingSecretKey`  | Key within that Secret                                                            | `ownerUrl`                                          |
| `muster.database.ownerUrl`                | The owning connection as a literal. For evaluation only                           | `~`                                                 |
| `muster.smtp.existingSecret`              | Secret holding the SMTP relay URL                                                 | `~`                                                 |
| `muster.smtp.existingSecretKey`           | Key within that Secret                                                            | `url`                                               |
| `muster.smtp.url`                         | The relay URL as a literal. For evaluation only                                   | `~`                                                 |
| `muster.migrations.enabled`               | Run the migration Job as a pre-install and pre-upgrade hook                       | `true`                                              |
| `muster.migrations.backoffLimit`          | Retries before the Job fails                                                      | `3`                                                 |
| `muster.migrations.activeDeadlineSeconds` | How long the Job may run                                                          | `600`                                               |
| `muster.service.type`                     | Service type                                                                      | `ClusterIP`                                         |
| `muster.service.port`                     | Port the Service listens on                                                       | `80`                                                |
| `muster.service.targetPort`               | Port the container listens on, which also sets `PORT`                             | `3000`                                              |
| `muster.service.annotations`              | Annotations on the Service                                                        | `{}`                                                |
| `muster.resources`                        | Requests and limits for the server and the migration Job                          | `{}`                                                |
| `muster.podAnnotations`                   | Extra annotations on the pod                                                      | `{}`                                                |
| `muster.podLabels`                        | Extra labels on the pod                                                           | `{}`                                                |
| `muster.podSecurityContext`               | Pod security context                                                              | non-root, uid 1000, `RuntimeDefault`                |
| `muster.securityContext`                  | Container security context                                                        | no privilege escalation, read-only root, drop `ALL` |
| `muster.terminationGracePeriodSeconds`    | Grace period on shutdown                                                          | `30`                                                |
| `muster.nodeSelector`                     | Node selector                                                                     | `{}`                                                |
| `muster.tolerations`                      | Tolerations                                                                       | `[]`                                                |
| `muster.affinity`                         | Affinity rules                                                                    | `{}`                                                |

`replicas` is deliberately absent - see "Why one replica".

### `muster.config`

Every variable the server reads except the four that are credentials. The
repository's `.env.example` documents all of them.

| Variable                        | Description                                                                                                             | Default in this chart                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `MUSTER_PUBLIC_URL`             | The origin every public URL derives from, including the issuer of every software statement and ticket. **Required**     | `""`, which the chart refuses to render           |
| `MUSTER_IHI_SYSTEM`             | The identifier namespace a persona's IHI is searched by. **Required**                                                   | `http://ns.electronichealth.net.au/id/hi/ihi/1.0` |
| `MUSTER_LOG_LEVEL`              | `debug`, `info`, `warn` or `error`                                                                                      | `info`                                            |
| `MUSTER_MAIL_FROM`              | The `From` address on every message                                                                                     | unset, derived from the public URL's host         |
| `MUSTER_CHECK_INTERVAL_MINUTES` | How often an open event's enrolled servers are verified. Fifteen is the ceiling the success criteria put on it          | unset, which is 15                                |
| `MUSTER_OUTBOUND_ALLOWED_HOSTS` | Hosts the outbound guard may reach on a private address or over plain HTTP. For development stacks; never in production | unset, which is empty                             |

`PORT` is set from `muster.service.targetPort` and must not be put here.
`MUSTER_WEB_ROOT` is baked into the image.

`MUSTER_DATABASE_URL`, `MUSTER_DATABASE_OWNER_URL`, `MUSTER_MASTER_KEY` and
`MUSTER_SMTP_URL` are credentials and have blocks of their own; putting one in
`config` would write it into the Deployment in plain text.

## Examples

### Production: every credential managed outside the chart

```yaml
muster:
  image: "ghcr.io/csiro/muster:0.1.0"
  config:
    MUSTER_PUBLIC_URL: "https://muster.example.org"
    MUSTER_IHI_SYSTEM: "http://ns.electronichealth.net.au/id/hi/ihi/1.0"
    MUSTER_MAIL_FROM: "Muster <no-reply@example.org>"
  masterKey:
    existingSecret: "muster-master-key"
  database:
    existingSecret: "muster-db"
    ownerExistingSecret: "muster-db-owner"
  smtp:
    existingSecret: "muster-smtp"
```

### Evaluation: the chart creates the Secrets

Every credential here ends up in a shell history, in `helm get values` and in
whatever ran the command. Use it to look at Muster, not to run one.

```bash
helm install muster deploy/helm/muster \
  --set muster.config.MUSTER_PUBLIC_URL=https://muster.example.org \
  --set muster.database.url="postgres://muster_app:app@db:5432/muster" \
  --set muster.database.ownerUrl="postgres://muster_owner:owner@db:5432/muster"
```

The envelope key is generated on install and annotated
`helm.sh/resource-policy: keep`, so upgrades preserve it.

### Behind a load balancer that terminates TLS

`MUSTER_PUBLIC_URL` is the address counterparties use, not the address the
container listens on. A server registering a client fetches the JWKS at
`{MUSTER_PUBLIC_URL}/.well-known/jwks.json`, so an origin that resolves only
inside the cluster produces statements nobody can verify.

The chart deliberately renders no Ingress: routing is deployment-specific.

## Testing the chart

```bash
helm lint deploy/helm/muster -f deploy/helm/example-values.yaml
helm template muster deploy/helm/muster -f deploy/helm/example-values.yaml
bun run check:chart
```

`check:chart` renders both secret arrangements and asserts what neither `helm
lint` nor a reading of the templates catches: one replica, the `Recreate`
strategy, no autoscaler, the owning identity confined to the migration Job,
every required variable present in the Deployment, no credential in the rendered
output when existing Secrets were supplied, and a refusal to render without
`MUSTER_PUBLIC_URL`. CI runs all three.

## Upgrading

The migration Job runs as a `pre-upgrade` hook, so a migration that fails leaves
the running pod in place. The `Recreate` strategy means the old pod is stopped
before the new one starts: expect a few seconds of downtime.

Changing `MUSTER_PUBLIC_URL` on an existing deployment invalidates every
software statement and permission ticket already in circulation, because it is
their issuer. Treat it as a new deployment rather than a setting.

## Uninstalling

```bash
helm uninstall muster
```

The generated master-key Secret is annotated `helm.sh/resource-policy: keep` and
survives, deliberately: the signing keys in the database are encrypted under it.
Delete it by hand once the database has gone.

```bash
kubectl delete secret muster-master-key
```
