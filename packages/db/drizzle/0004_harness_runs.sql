CREATE TYPE "public"."harness_verdict" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "harness_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"run_by" uuid NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"verdict" "harness_verdict" NOT NULL,
	"checks" jsonb NOT NULL,
	"cleanup" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_run" ADD CONSTRAINT "harness_run_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_run" ADD CONSTRAINT "harness_run_run_by_account_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harness_run_enrolment_id_ran_at_idx" ON "harness_run" USING btree ("enrolment_id","ran_at" DESC NULLS LAST);