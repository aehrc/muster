CREATE TYPE "harness_verdict" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "harness_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"run_by" uuid NOT NULL,
	"verdict" "harness_verdict" NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_run" ADD CONSTRAINT "harness_run_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_run" ADD CONSTRAINT "harness_run_run_by_account_id_fk" FOREIGN KEY ("run_by") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harness_run_enrolment_created_at_idx" ON "harness_run" USING btree ("enrolment_id","created_at" DESC NULLS LAST);