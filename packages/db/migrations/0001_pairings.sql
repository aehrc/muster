CREATE TYPE "pairing_state" AS ENUM('requested', 'fulfilled', 'declined', 'failed', 'lapsed');--> statement-breakpoint
CREATE TABLE "pairing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"client_enrolment_id" uuid NOT NULL,
	"server_enrolment_id" uuid NOT NULL,
	"state" "pairing_state" DEFAULT 'requested' NOT NULL,
	"registration_fields" jsonb NOT NULL,
	"client_id" text,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_eventId_clientEnrolmentId_serverEnrolmentId_unique" UNIQUE("event_id","client_enrolment_id","server_enrolment_id")
);
--> statement-breakpoint
CREATE TABLE "pairing_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"actor_account_id" uuid,
	"acting_for_organisation_id" uuid,
	"from_state" "pairing_state",
	"to_state" "pairing_state" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_client_enrolment_id_enrolment_id_fk" FOREIGN KEY ("client_enrolment_id") REFERENCES "enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_server_enrolment_id_enrolment_id_fk" FOREIGN KEY ("server_enrolment_id") REFERENCES "enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_pairing_id_pairing_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "pairing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_acting_for_organisation_id_organisation_id_fk" FOREIGN KEY ("acting_for_organisation_id") REFERENCES "organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The timeline is append-only (FR-013). Both parties read one history, and a row
-- saying who did what is not something a later statement gets to revise, so the
-- rule is in the database rather than in a route handler that a later route
-- handler forgets. The error code is the one PostgreSQL uses for a violated
-- check, so callers classify it without matching message text.
create function pairing_event_append_only() returns trigger as $$
begin
  raise exception 'The pairing timeline is append-only'
    using errcode = '23514';
end;
$$ language plpgsql;
--> statement-breakpoint
create trigger pairing_event_append_only
before update or delete on pairing_event
for each row execute function pairing_event_append_only();
