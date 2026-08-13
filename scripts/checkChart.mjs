/**
 * Author: John Grimes
 */

// Asserts the properties of the Helm chart that are properties of its *output*.
//
// Three of the constitution's rules survive or die in rendered YAML, and none of
// them is visible to `helm lint`, which only asks whether the templates parse and
// whether Chart.yaml is well formed. A chart that scaled Muster to three pods, or
// that handed the server the identity that owns its schema, or that dropped the one
// variable every public URL derives from, renders perfectly well and lints clean.
// The only thing that catches any of them is reading the output, so that is what
// this does.
//
//   1. **One replica, and one at a time.** Scheduled work runs on in-process
//      intervals inside the single server instance, so a second pod is a second
//      scheduler racing the first over the same enrolments. That means `replicas: 1`
//      and it also means the `Recreate` strategy: a rolling update that surges
//      would run two schedulers for the length of the rollout, which is precisely
//      the thing the constraint forbids. A HorizontalPodAutoscaler would undo both,
//      so the absence of one is asserted too.
//
//   2. **The server does not hold the owning identity.** Migrations are DDL and are
//      applied by the identity that owns the schema; the server serves with a role
//      that cannot issue DDL. A Deployment carrying `MUSTER_DATABASE_OWNER_URL`
//      would make that split a convention rather than a constraint.
//
//   3. **Every variable the server refuses to start without is present.**
//      `apps/server/src/config.ts` denies by default, so a chart missing one fails
//      the rollout - loudly, but at deploy time on somebody else's cluster rather
//      than here.
//
// And one property of the secrets: when an operator points the chart at their own
// Secrets, no credential may appear in the rendered manifests. That is the whole
// point of the `existingSecret` pattern, and a template that read the value and
// wrote it into a Secret of its own would satisfy every other assertion here.
//
// Run as `bun run check:chart`, and in CI beside `helm lint`. Requires `helm` on the
// path and fails loudly without it rather than reporting success: a check that skips
// itself is the failure mode the whole gate exists to prevent.
//
// Usage: node scripts/checkChart.mjs

import { execFileSync } from "node:child_process";

/** The chart, relative to the repository root. */
const CHART = "deploy/helm/muster";

/** The variable naming the identity that owns the schema. */
const OWNER_VARIABLE = "MUSTER_DATABASE_OWNER_URL";

/**
 * Secret keys that would give a pod the owning identity.
 *
 * The key rather than only the variable, because a Deployment mounting the owner
 * Secret under another variable's name would hand over the same authority.
 */
const OWNER_SECRET_KEYS = ["ownerUrl"];

/**
 * What the server refuses to start without, per `apps/server/src/config.ts`.
 *
 * `PORT` is here because the probes address the container by a port the chart
 * chooses, and a server listening somewhere else fails readiness with nothing to
 * say why.
 */
const REQUIRED_SERVER_VARIABLES = [
  "PORT",
  "MUSTER_PUBLIC_URL",
  "MUSTER_DATABASE_URL",
  "MUSTER_MASTER_KEY",
  "MUSTER_IHI_SYSTEM",
];

/** The credentials the "existing secret" render must not contain. */
const LITERAL_CREDENTIALS = [
  "postgres://serving:serving-password@db.example.org:5432/muster",
  "postgres://owner:owner-password@db.example.org:5432/muster",
  "smtp://relay-user:relay-password@smtp.example.org:587",
  "0123456789abcdef0123456789abcdef",
];

/** The configurations to render, and what each one is for. */
const CONFIGURATIONS = [
  {
    name: "operator-managed secrets",
    // The shape a real deployment has: every credential lives in a Secret the
    // chart neither creates nor reads.
    flags: [
      "--set",
      "muster.config.MUSTER_PUBLIC_URL=https://muster.example.org",
      "--set",
      "muster.database.existingSecret=muster-db",
      "--set",
      "muster.database.ownerExistingSecret=muster-db-owner",
      "--set",
      "muster.masterKey.existingSecret=muster-master-key",
      "--set",
      "muster.smtp.existingSecret=muster-smtp",
    ],
    secretsAreExternal: true,
  },
  {
    // The other branch of the templates: the chart creates the Secrets from
    // values, which is what an evaluation deployment does.
    name: "chart-created secrets",
    flags: [
      "--set",
      "muster.config.MUSTER_PUBLIC_URL=https://muster.example.org",
      "--set",
      `muster.database.url=${LITERAL_CREDENTIALS[0]}`,
      "--set",
      `muster.database.ownerUrl=${LITERAL_CREDENTIALS[1]}`,
      "--set",
      `muster.smtp.url=${LITERAL_CREDENTIALS[2]}`,
      "--set",
      `muster.masterKey.value=${LITERAL_CREDENTIALS[3]}`,
    ],
    secretsAreExternal: false,
  },
];

/**
 * Renders the chart, returning its manifests split into documents.
 *
 * @param flags - Extra arguments to `helm template`.
 * @returns The rendered documents.
 */
function render(flags) {
  const output = execFileSync("helm", ["template", "muster", CHART, ...flags], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // Captured rather than inherited, because one of the renders below is
    // *expected* to fail and its message is read rather than printed.
    stdio: ["ignore", "pipe", "pipe"],
  });

  return output
    .split(/^---$/m)
    .map((document) => document.trim())
    .filter((document) => document.length > 0);
}

/**
 * A manifest's `kind`, or undefined when it declares none.
 *
 * @param document - One rendered manifest.
 * @returns The kind.
 */
function kindOf(document) {
  return /^kind:\s*(\S+)/m.exec(document)?.[1];
}

/**
 * A manifest's `metadata.name`.
 *
 * @param document - One rendered manifest.
 * @returns The name.
 */
function nameOf(document) {
  return /^metadata:\s*\n(?:\s+.*\n)*?\s+name:\s*(\S+)/m.exec(document)?.[1];
}

const failures = [];

/**
 * Records a failure rather than throwing, so one run reports every problem.
 *
 * @param condition - What must hold.
 * @param message - What is wrong when it does not.
 */
function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

for (const { name, flags, secretsAreExternal } of CONFIGURATIONS) {
  const documents = render(flags);

  const deployments = documents.filter(
    (document) => kindOf(document) === "Deployment",
  );
  const migrationJobs = documents.filter(
    (document) =>
      kindOf(document) === "Job" &&
      (nameOf(document) ?? "").endsWith("-migrate"),
  );

  // Guards the guard. A render that produced neither would let every assertion
  // below pass while asserting nothing at all.
  check(
    deployments.length === 1,
    `${name}: expected exactly one Deployment, found ${String(deployments.length)}`,
  );
  check(
    migrationJobs.length === 1,
    `${name}: expected exactly one migration Job, found ${String(migrationJobs.length)}`,
  );

  for (const document of migrationJobs) {
    check(
      document.includes(OWNER_VARIABLE),
      `${name}: the migration Job does not carry ${OWNER_VARIABLE}, so it cannot apply DDL as the identity that owns the schema`,
    );
    check(
      document.includes('["bun", "dist/index.js", "migrate"]'),
      `${name}: the migration Job does not run the migrate command`,
    );
  }

  for (const document of deployments) {
    // One instance, and never two at once. The scheduler is in the server
    // process, so a surge during a rollout is a second scheduler.
    check(
      /^\s+replicas:\s*1$/m.test(document),
      `${name}: the Deployment does not pin replicas to 1. Scheduled work runs on in-process intervals inside the single server instance`,
    );
    check(
      /^\s+type:\s*Recreate$/m.test(document),
      `${name}: the Deployment does not use the Recreate strategy. A rolling update runs the old and new pods together, which is two schedulers over the same enrolments`,
    );

    check(
      !document.includes(OWNER_VARIABLE),
      `${name}: the server's Deployment carries ${OWNER_VARIABLE}. A server holding the owning identity can issue DDL, and the two-identity split becomes a convention rather than a constraint`,
    );
    for (const key of OWNER_SECRET_KEYS) {
      check(
        !document.includes(key),
        `${name}: the server's Deployment references the secret key "${key}", which is the owning identity under another name`,
      );
    }

    for (const variable of REQUIRED_SERVER_VARIABLES) {
      check(
        document.includes(`name: ${variable}`),
        `${name}: the server's Deployment does not set ${variable}, which the configuration loader refuses to start without`,
      );
    }
  }

  check(
    !documents.some(
      (document) => kindOf(document) === "HorizontalPodAutoscaler",
    ),
    `${name}: the chart rendered a HorizontalPodAutoscaler, which would undo the single-instance constraint the scheduler depends on`,
  );

  if (secretsAreExternal) {
    check(
      !documents.some((document) => kindOf(document) === "Secret"),
      `${name}: the chart created a Secret even though every credential was supplied as an existing one`,
    );
    for (const credential of LITERAL_CREDENTIALS) {
      check(
        !documents.some((document) => document.includes(credential)),
        `${name}: a credential appears in the rendered output`,
      );
    }
  } else {
    // The other direction: when the chart is asked to create the Secrets, they
    // have to be there. A branch that quietly created nothing would leave the
    // Deployment pointing at Secrets that do not exist.
    check(
      documents.filter((document) => kindOf(document) === "Secret").length ===
        4,
      `${name}: expected the chart to create four Secrets (serving connection, owning connection, master key, SMTP)`,
    );
  }
}

// The other half of "MUSTER_PUBLIC_URL is required": a render without it has to
// fail. Asserted by rendering, because a `fail` that was quietly deleted from the
// templates would leave a chart that installs happily and emits links to nowhere -
// and every assertion above would still pass.
try {
  render([]);
  failures.push(
    "the chart rendered with no MUSTER_PUBLIC_URL. Every public URL Muster emits derives from it, so a deployment without one must be refused rather than installed",
  );
} catch (error) {
  const said = `${String(error?.stderr ?? "")}${error instanceof Error ? error.message : String(error)}`;
  check(
    said.includes("MUSTER_PUBLIC_URL"),
    `the render without a public URL failed for some other reason: ${said}`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`✗ ${failure}`);
  }
  process.exit(1);
}

console.log(
  `✓ ${String(CONFIGURATIONS.length)} chart configurations keep Muster to one instance, keep the owning identity to the migration Job, and set every variable the server requires`,
);
