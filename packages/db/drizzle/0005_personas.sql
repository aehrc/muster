CREATE TYPE "public"."persona_coverage_outcome" AS ENUM('found', 'missing', 'unverifiable');--> statement-breakpoint
CREATE TYPE "public"."persona_source_status" AS ENUM('present', 'missing');--> statement-breakpoint
CREATE TABLE "persona" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"patient_id" text NOT NULL,
	"display" jsonb NOT NULL,
	"ihi" text NOT NULL,
	"source_status" "persona_source_status" DEFAULT 'present' NOT NULL,
	"source_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persona_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"outcome" "persona_coverage_outcome" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_coverage" ADD CONSTRAINT "persona_coverage_persona_id_persona_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."persona"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persona_coverage" ADD CONSTRAINT "persona_coverage_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."enrolment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "persona_event_id_idx" ON "persona" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persona_event_id_ihi_key" ON "persona" USING btree ("event_id","ihi");--> statement-breakpoint
CREATE INDEX "persona_coverage_pair_checked_at_idx" ON "persona_coverage" USING btree ("persona_id","enrolment_id","checked_at" DESC NULLS LAST);