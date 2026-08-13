CREATE TYPE "public"."pairing_state" AS ENUM('requested', 'fulfilled', 'declined', 'failed', 'lapsed');--> statement-breakpoint
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
	CONSTRAINT "pairing_fulfilled_has_client_id" CHECK ("pairing"."state" <> 'fulfilled' or "pairing"."client_id" is not null),
	CONSTRAINT "pairing_declined_has_reason" CHECK ("pairing"."state" <> 'declined' or "pairing"."decline_reason" is not null)
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
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_client_enrolment_id_enrolment_id_fk" FOREIGN KEY ("client_enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_server_enrolment_id_enrolment_id_fk" FOREIGN KEY ("server_enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_pairing_id_pairing_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."pairing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_event" ADD CONSTRAINT "pairing_event_acting_for_organisation_id_organisation_id_fk" FOREIGN KEY ("acting_for_organisation_id") REFERENCES "public"."organisation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_event_client_server_unique" ON "pairing" USING btree ("event_id","client_enrolment_id","server_enrolment_id");--> statement-breakpoint
CREATE INDEX "pairing_client_enrolment_id_idx" ON "pairing" USING btree ("client_enrolment_id");--> statement-breakpoint
CREATE INDEX "pairing_server_enrolment_id_idx" ON "pairing" USING btree ("server_enrolment_id");--> statement-breakpoint
CREATE INDEX "pairing_event_id_idx" ON "pairing" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "pairing_event_pairing_id_at_idx" ON "pairing_event" USING btree ("pairing_id","at");