CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"minted_by" uuid NOT NULL,
	"jti" text NOT NULL,
	"key_id" text NOT NULL,
	"claims" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_minted_by_account_id_fk" FOREIGN KEY ("minted_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_key_id_signing_key_kid_fk" FOREIGN KEY ("key_id") REFERENCES "public"."signing_key"("kid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_jti_unique" ON "ticket" USING btree ("jti");--> statement-breakpoint
CREATE INDEX "ticket_event_id_created_at_idx" ON "ticket" USING btree ("event_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ticket_key_id_expires_at_idx" ON "ticket" USING btree ("key_id","expires_at");