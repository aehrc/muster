# Muster Helm chart

Deploys Muster, the connectathon participant directory: the JSON API, the web
console and the in-process scheduler, as one container behind one service.

## Features

- One image serves the API, the public event pages and the console, so a release
  has a single public URL and nothing to reverse-proxy together.
- Credentials come from a Secret the chart does not own (`existingSecret`), so
  no credential is written into a release.
- `replicas` is pinned to 1, with the reason stated in the template: scheduled
  work runs on an in-process interval, and a second replica would run a second
  copy of it.
- Probes read `/healthz`, which needs no configuration and touches nothing.
- Migrations are applied by the container at start-up, by the owning database
  role, before it serves with the non-owning one.
- The defaults satisfy the `restricted` Pod Security Standard: non-root by uid,
  no privilege escalation, a read-only root file system, every capability
  dropped, and the default seccomp profile. No service account token is mounted,
  because Muster does not talk to the Kubernetes API.
- A change to `secretConfig` restarts the pod, because the Deployment carries a
  checksum of it; a change to the Secret named by `existingSecret` does not, and
  is applied by restarting the deployment yourself.

## Prerequisites

- Kubernetes 1.25 or later, and Helm 3.19 or 4.x (both are exercised in CI).
- A PostgreSQL 18 database, reachable from the cluster, with two roles: an
  owning role that may apply migrations, and a non-owning serving role. The
  container bootstraps the serving role using the owning role's connection.
- A Secret holding the credentials (below). The chart does not create one for
  you, and does not deploy a database.

## Installation

Create the Secret first. Every key in it becomes an environment variable, so it
holds exactly the variables Muster reads:

```bash
kubectl create secret generic muster-credentials \
  --from-literal=MUSTER_MASTER_KEY="$(openssl rand -hex 32)" \
  --from-literal=MUSTER_MIGRATION_DATABASE_URL='postgresql://muster_owner:...@postgres:5432/muster' \
  --from-literal=MUSTER_DATABASE_URL='postgresql://muster_server:...@postgres:5432/muster' \
  --from-literal=MUSTER_SERVER_DATABASE_PASSWORD='...' \
  --from-literal=MUSTER_SMTP_URL='smtps://muster:...@smtp.example.org:465'
```

Then install:

```bash
helm install muster deploy/helm/muster \
  --set muster.image=ghcr.io/aehrc/muster:0.1.0 \
  --set muster.publicUrl=https://muster.example.org \
  --set muster.existingSecret=muster-credentials
```

`MUSTER_MASTER_KEY` is the key private signing keys are encrypted under at rest.
Losing it makes every stored signing key unreadable; changing it makes the keys
encrypted under the old one unreadable, so rotate by minting new keys rather
than by editing the Secret.

The chart refuses to render rather than guessing:

```bash
# Error: muster.publicUrl is required: every URL Muster advertises derives from it.
helm template muster deploy/helm/muster

# Error: Muster needs its credentials: set muster.existingSecret ...
helm template muster deploy/helm/muster --set muster.publicUrl=https://muster.example.org
```

## Configuration

| Parameter                              | Description                                                                                           | Default                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `muster.image`                         | Container image to run                                                                                | `muster:latest`                                                   |
| `muster.imagePullPolicy`               | Image pull policy                                                                                     | `Always`                                                          |
| `muster.publicUrl`                     | The externally reachable base URL. **Required**; every URL Muster mints or advertises derives from it | `~`                                                               |
| `muster.existingSecret`                | Name of an existing Secret whose keys become environment variables. Where the credentials belong      | `~`                                                               |
| `muster.secretConfig`                  | Sensitive environment variables for the chart to hold in a Secret it creates. For a trial only        | `{}`                                                              |
| `muster.config`                        | Non-sensitive environment variables, passed through as given                                          | `{}`                                                              |
| `muster.service.type`                  | Service type                                                                                          | `ClusterIP`                                                       |
| `muster.service.port`                  | Port the service and the container listen on                                                          | `8080`                                                            |
| `muster.terminationGracePeriodSeconds` | Time the container is given to stop                                                                   | `30`                                                              |
| `muster.resources`                     | Container resource requests and limits                                                                | `{}`                                                              |
| `muster.podSecurityContext`            | Pod-level security context                                                                            | non-root as uid/gid 1000, `seccompProfile: RuntimeDefault`        |
| `muster.securityContext`               | Container-level security context                                                                      | no privilege escalation, read-only root, all capabilities dropped |
| `muster.nodeSelector`                  | Node selector for the pod                                                                             | `{}`                                                              |
| `muster.tolerations`                   | Tolerations for the pod                                                                               | `[]`                                                              |
| `muster.affinity`                      | Affinity rules for the pod                                                                            | `{}`                                                              |

`replicas` is deliberately absent: see the comment at the top of
`templates/deployment.yaml`.

### Environment variables Muster reads

Set the first group through `muster.config`, and the second through the Secret
named by `muster.existingSecret`.

| Variable                          | Purpose                                                                | Default                                           |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `MUSTER_PUBLIC_URL`               | Set by the chart from `muster.publicUrl`                               | required                                          |
| `MUSTER_PORT`                     | Set by the chart from `muster.service.port`                            | `8080`                                            |
| `MUSTER_MAIL_FROM`                | From address on outbound mail                                          | `muster@` the public URL's host                   |
| `MUSTER_SERVER_DATABASE_ROLE`     | The non-owning serving role to bootstrap                               | `muster_server`                                   |
| `MUSTER_MIGRATIONS_DIRECTORY`     | Where the `.sql` migrations are, relative to the working directory     | `migrations`                                      |
| `MUSTER_WEB_DIRECTORY`            | Where the built console is. An absent directory serves the API alone   | `web`                                             |
| `MUSTER_OUTBOUND_TIMEOUT_MS`      | Deadline for one outbound request                                      | `10000`                                           |
| `MUSTER_OUTBOUND_ALLOWLIST`       | Hosts exempted from the address guard. **Leave unset in a deployment** | empty                                             |
| `MUSTER_IHI_SYSTEM`               | The identifier system a persona's IHI is asserted under                | `http://ns.electronichealth.net.au/id/hi/ihi/1.0` |
| `MUSTER_MASTER_KEY`               | Key that private signing keys are encrypted under at rest              | required, secret                                  |
| `MUSTER_DATABASE_URL`             | Connection URL for the non-owning serving role                         | required, secret                                  |
| `MUSTER_MIGRATION_DATABASE_URL`   | Connection URL for the owning role, which applies migrations           | required, secret                                  |
| `MUSTER_SERVER_DATABASE_PASSWORD` | Password to set on the serving role when bootstrapping it              | unset, secret                                     |
| `MUSTER_SMTP_URL`                 | Where mail is sent. Unset writes messages to the log instead           | unset, secret                                     |

`MUSTER_OUTBOUND_ALLOWLIST` names hosts the SSRF guard will not check, and it is
also what permits a participant entry to name an `http` endpoint. Both
relaxations exist for the local stack's stubs. A deployment leaves it unset, and
then no private address is reachable and no plaintext endpoint can be recorded.

## Examples

A deployment that sends mail through a relay and is reachable through an ingress
controller you manage separately:

```yaml
muster:
  image: "ghcr.io/aehrc/muster:0.1.0"
  publicUrl: "https://muster.example.org"
  existingSecret: "muster-credentials"
  config:
    MUSTER_MAIL_FROM: "Muster <muster@example.org>"
  resources:
    requests:
      memory: "256Mi"
      cpu: "100m"
    limits:
      memory: "512Mi"
      cpu: "500m"
```

A trial install with no Secret of your own, which keeps the credentials in the
release and is therefore not for anything real:

```yaml
muster:
  publicUrl: "http://localhost:8080"
  secretConfig:
    MUSTER_MASTER_KEY: "trial-key-not-a-secret"
    MUSTER_MIGRATION_DATABASE_URL: "postgresql://muster_owner:muster_owner@postgres:5432/muster"
    MUSTER_DATABASE_URL: "postgresql://muster_server:muster_server@postgres:5432/muster"
    MUSTER_SERVER_DATABASE_PASSWORD: "muster_server"
```

An event source in another programme, with its own identifier system:

```yaml
muster:
  publicUrl: "https://muster.example.org"
  existingSecret: "muster-credentials"
  config:
    MUSTER_IHI_SYSTEM: "http://example.org/id/national-patient-identifier"
```

## Upgrading

The container applies any new migrations at start-up, so an upgrade is an image
change. The strategy is `Recreate`, so the old pod stops before the new one
starts and there is a short outage; that is deliberate, because two instances
would run two schedulers. The server stops on `SIGTERM` after finishing the
requests in flight, within `terminationGracePeriodSeconds`.

A change to the Secret named by `existingSecret` needs a restart to take effect:

```bash
kubectl rollout restart deployment/muster-deployment
```

Because signing keys are encrypted under `MUSTER_MASTER_KEY`, an upgrade must
keep the same value in the Secret. A release that changes it starts, but the keys
minted under the old value can no longer be read.

## Uninstalling

```bash
helm uninstall muster
```

Nothing in the release holds state: the database is yours and is untouched, as is
the Secret when it is one you created. A release that used `secretConfig` takes
its Secret with it.

## Version compatibility

| Chart version | App version | Kubernetes | Helm         |
| ------------- | ----------- | ---------- | ------------ |
| 0.1.0         | 0.1.0       | 1.25+      | 3.19+ or 4.x |
