/**
 * What the stack holds, and what the suite puts in it.
 *
 * One module rather than a literal per spec, so that the account spec 1 creates is
 * recognisably the account spec 7 mints a ticket as, and so that changing an address is one
 * edit rather than a search.
 *
 * The server entries point at the stubs by their **compose names**, and that is not a
 * shortcut: an address typed into Muster is an address Muster fetches, from inside the
 * network, and it is the name the stubs' certificate carries.
 *
 * Author: John Grimes
 */

import { resolveStackUrls } from "../src/stackUrls.js";

/** Where everything is. */
export const URLS = resolveStackUrls(process.env);

/** The event the seed opens, and the values it opens it with. */
export const EVENT = {
  slug: "sparked-2026-09",
  name: "Sparked Connectathon September 2026",
} as const;

/** The administrator the seed creates. Its credentials are the seed's own defaults. */
export const ADMIN = {
  email: "admin@muster.test",
  password: "correct horse battery staple",
  displayName: "Track Admin",
} as const;

/** The app owner of quickstart scenario 1, and the organisation they create. */
export const APP_OWNER = {
  email: "app.owner@muster.test",
  displayName: "Avery Quinn",
  password: "app owner horse battery staple",
  organisation: "CSIRO",
} as const;

/** The server owner of quickstart scenario 1, and the organisation they create. */
export const SERVER_OWNER = {
  email: "server.owner@muster.test",
  displayName: "Sam Ryan",
  password: "server owner horse battery staple",
  organisation: "MediRecords",
} as const;

/** Where each signed-in session is kept, so a spec need not sign in again. */
export const SESSIONS = {
  admin: "playwright/.auth/admin.json",
  appOwner: "playwright/.auth/appOwner.json",
  serverOwner: "playwright/.auth/serverOwner.json",
} as const;

/** The persona the data holder has loaded, and the one it refuses. */
export const PERSONA = {
  name: "Charlotte Morris",
  ihi: "8003608500314687",
  ihiSystem: "http://ns.electronichealth.net.au/id/hi/ihi/1.0",
  /** Carries no IHI, so curating it is refused (FR-031). */
  ineligibleName: "Rowan Bell",
} as const;

/** The client the app owner brings. */
export const SMART_FORMS = {
  name: "Smart Forms",
  launchUrl: "https://smartforms.example.org/launch",
  // At least one is required: without it the authorization code flow cannot complete.
  redirectUri: "https://smartforms.example.org/callback",
  tags: "smart-app",
} as const;

/**
 * The server the server owner brings, answering pairing requests by hand.
 *
 * Pointed at the data holder, which answers a patient search - so this is also the entry the
 * coverage grid reports as holding the persona.
 */
export const MEDIRECORDS = {
  name: "MediRecords FHIR",
  fhirBaseUrl: URLS.dataHolderInternal,
  // What the holder's own smart-configuration advertises, so this entry does not drift.
  tokenEndpoint: `${URLS.dataHolderInternal}/token`,
  tags: "smart-app-host",
} as const;

/** The server that accepts Muster-vouched registration, and refuses a patient search. */
export const STUB_AUTH = {
  name: "Stub Auth",
  fhirBaseUrl: URLS.registrationStubInternal,
  registrationEndpoint: `${URLS.registrationStubInternal}/register`,
  tags: "smart-app-host",
} as const;

/** A server whose declared token endpoint is not what it advertises (scenario 5). */
export const DRIFTING = {
  name: "Drifting FHIR",
  fhirBaseUrl: URLS.dataHolderInternal,
  tokenEndpoint: "https://token.elsewhere.example.org/token",
  tags: "smart-app-host",
} as const;

/** A server on a private address, which the outbound guard refuses (scenario 5). */
export const GUARDED = {
  name: "Private Range FHIR",
  fhirBaseUrl: "https://10.0.0.1/fhir",
  tags: "smart-app-host",
} as const;

/** The client identifier the server owner issues by hand in scenario 2. */
export const MANUAL_CLIENT_ID = "smart-forms-test-1";

/** The credential the data holder expects from whoever presents a ticket. */
export const HOLDER_CLIENT = {
  id: "muster-playground",
  secret: "playground-secret",
} as const;
