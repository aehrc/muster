CREATE TYPE "public"."check_failure_mode" AS ENUM('timeout', 'refused', 'guarded', 'invalid');--> statement-breakpoint
CREATE TABLE "check_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"reachable" boolean NOT NULL,
	"failure_mode" "check_failure_mode",
	"detail" text,
	"discovery" jsonb,
	"capability" jsonb,
	"drift_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_result_reachable_has_no_failure_mode" CHECK ("check_result"."reachable" = ("check_result"."failure_mode" is null))
);
--> statement-breakpoint
ALTER TABLE "check_result" ADD CONSTRAINT "check_result_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_result_enrolment_id_checked_at_idx" ON "check_result" USING btree ("enrolment_id","checked_at" DESC NULLS LAST);