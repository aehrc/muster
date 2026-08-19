CREATE TYPE "coverage_outcome" AS ENUM('found', 'missing', 'unverifiable');--> statement-breakpoint
CREATE TYPE "persona_source_status" AS ENUM('present', 'missing');--> statement-breakpoint
CREATE TABLE "persona" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"patient_id" text NOT NULL,
	"ihi" text NOT NULL,
	"display" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"source_status" "persona_source_status" DEFAULT 'present' NOT NULL,
	"source_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persona_eventId_ihi_unique" UNIQUE("event_id","ihi")
);
--> statement-breakpoint
CREATE TABLE "persona_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "coverage_outcome" NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_coverage" ADD CONSTRAINT "persona_coverage_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "persona"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_coverage" ADD CONSTRAINT "persona_coverage_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "enrolment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_coverage_pair_checked_at_idx" ON "persona_coverage" USING btree ("persona_id","enrolment_id","checked_at" DESC NULLS LAST);