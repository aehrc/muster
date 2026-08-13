{{/*
Labels applied to every resource in the chart.
*/}}
{{- define "muster.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "muster.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The labels a Service or Deployment selects the server's pods by. Nothing that
changes between revisions may appear here: a Deployment's selector is immutable
once created.
*/}}
{{- define "muster.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Refuses to render a deployment that cannot work, naming what is missing.

`apps/server/src/config.ts` denies by default: a missing public URL, a missing
IHI namespace or an unusable connection stops startup rather than being guessed
at. Repeating those refusals here moves them from a CrashLoopBackOff on
somebody's cluster to the command that asked for the install.

MUSTER_PUBLIC_URL is the consequential one. Every public URL Muster emits
derives from it - the issuer of every software statement and permission ticket,
the JWKS address a counterparty fetches keys from, the link in every
verification email - so a deployment that changes it invalidates everything
already in circulation, and one that never set it emits links to nowhere.
*/}}
{{- define "muster.validate" -}}
{{- if not (.Values.muster.config.MUSTER_PUBLIC_URL | default "" | trim) }}
{{- fail "muster.config.MUSTER_PUBLIC_URL is required: it is the origin every public URL Muster emits derives from, including the issuer of every software statement and permission ticket, so it must be the address counterparties reach Muster on" }}
{{- end }}
{{- if not (.Values.muster.config.MUSTER_IHI_SYSTEM | default "" | trim) }}
{{- fail "muster.config.MUSTER_IHI_SYSTEM is required: it is the identifier namespace a persona's IHI is searched by, and a wrong or absent value makes every coverage check report a miss against servers that hold the patient" }}
{{- end }}
{{- if and (not .Values.muster.database.existingSecret) (not .Values.muster.database.url) }}
{{- fail "muster.database.url or muster.database.existingSecret must be set: it is the non-owning connection the server serves with" }}
{{- end }}
{{- if .Values.muster.migrations.enabled }}
{{- if and (not .Values.muster.database.ownerExistingSecret) (not .Values.muster.database.ownerUrl) }}
{{- fail "muster.database.ownerUrl or muster.database.ownerExistingSecret must be set when muster.migrations.enabled is true: migrations are DDL and are applied by the identity that owns the schema, which the server must not connect as" }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
The name of the Secret holding the serving connection, and its key.
*/}}
{{- define "muster.databaseSecretName" -}}
{{- .Values.muster.database.existingSecret | default (printf "%s-db" .Release.Name) -}}
{{- end -}}
{{- define "muster.databaseSecretKey" -}}
{{- if .Values.muster.database.existingSecret -}}
{{- .Values.muster.database.existingSecretKey -}}
{{- else -}}
url
{{- end -}}
{{- end -}}

{{/*
The serving connection, as an environment entry.

Shared by the server's Deployment and the migration Job so the two can never
disagree about which database they are pointed at, or about which role the
server will connect as. The Job reads it for the role *name* alone: it grants
that role the access the server needs, and never uses its password.
*/}}
{{- define "muster.servingEnv" -}}
- name: MUSTER_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "muster.databaseSecretName" . | quote }}
      key: {{ include "muster.databaseSecretKey" . | quote }}
{{- end -}}

{{/*
The server's environment.

The serving identity, the envelope key, the relay if there is one, and whatever
plain configuration the operator set. Deliberately *not* the owning identity:
that appears in `muster.ownerEnv` below and reaches the migration Job alone, and
`scripts/checkChart.mjs` asserts as much against the rendered output.
*/}}
{{- define "muster.env" -}}
- name: PORT
  value: {{ .Values.muster.service.targetPort | quote }}
{{- range $name, $value := .Values.muster.config }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{ include "muster.servingEnv" . }}
- name: MUSTER_MASTER_KEY
  valueFrom:
    secretKeyRef:
{{- if .Values.muster.masterKey.existingSecret }}
      name: {{ .Values.muster.masterKey.existingSecret | quote }}
      key: {{ .Values.muster.masterKey.existingSecretKey | quote }}
{{- else }}
      name: {{ printf "%s-master-key" .Release.Name | quote }}
      key: masterKey
{{- end }}
{{- if or .Values.muster.smtp.existingSecret .Values.muster.smtp.url }}
- name: MUSTER_SMTP_URL
  valueFrom:
    secretKeyRef:
{{- if .Values.muster.smtp.existingSecret }}
      name: {{ .Values.muster.smtp.existingSecret | quote }}
      key: {{ .Values.muster.smtp.existingSecretKey | quote }}
{{- else }}
      name: {{ printf "%s-smtp" .Release.Name | quote }}
      key: url
{{- end }}
{{- end }}
{{- end -}}

{{/*
The migration Job's environment: the serving connection, and the owning one.

Those two and nothing else, because `migrate` reads nothing else - it dispatches
before the server's configuration is loaded, so a Job given the envelope key or
the public URL would be holding credentials and settings it has no use for.
*/}}
{{- define "muster.migrationEnv" -}}
{{ include "muster.servingEnv" . }}
- name: MUSTER_DATABASE_OWNER_URL
  valueFrom:
    secretKeyRef:
{{- if .Values.muster.database.ownerExistingSecret }}
      name: {{ .Values.muster.database.ownerExistingSecret | quote }}
      key: {{ .Values.muster.database.ownerExistingSecretKey | quote }}
{{- else }}
      name: {{ printf "%s-db-owner" .Release.Name | quote }}
      key: ownerUrl
{{- end }}
{{- end -}}
