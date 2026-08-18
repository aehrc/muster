CREATE TYPE "check_failure_mode" AS ENUM('timeout', 'refused', 'guarded', 'invalid');--> statement-breakpoint
CREATE TABLE "check_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reachable" boolean NOT NULL,
	"failure_mode" "check_failure_mode",
	"detail" text,
	"discovery" jsonb,
	"capability" jsonb,
	"drift_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_result" ADD CONSTRAINT "check_result_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_result_enrolment_checked_at_idx" ON "check_result" USING btree ("enrolment_id","checked_at" DESC NULLS LAST);