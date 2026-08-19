CREATE TYPE "signing_key_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "signing_purpose" AS ENUM('statements', 'tickets');--> statement-breakpoint
CREATE TABLE "signing_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid" text NOT NULL,
	"purpose" "signing_purpose" NOT NULL,
	"status" "signing_key_status" DEFAULT 'active' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_key_kid_unique" UNIQUE("kid")
);
--> statement-breakpoint
CREATE TABLE "software_statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"minted_by" uuid NOT NULL,
	"key_id" text NOT NULL,
	"claims" jsonb NOT NULL,
	"jws" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "software_statement_jti_unique" UNIQUE("jti")
);
--> statement-breakpoint
ALTER TABLE "software_statement" ADD CONSTRAINT "software_statement_pairing_id_pairing_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "pairing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_statement" ADD CONSTRAINT "software_statement_minted_by_account_id_fk" FOREIGN KEY ("minted_by") REFERENCES "account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_statement" ADD CONSTRAINT "software_statement_key_id_signing_key_kid_fk" FOREIGN KEY ("key_id") REFERENCES "signing_key"("kid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signing_key_one_active_per_purpose" ON "signing_key" USING btree ("purpose") WHERE "signing_key"."status" = 'active';--> statement-breakpoint
CREATE INDEX "software_statement_pairing_created_at_idx" ON "software_statement" USING btree ("pairing_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "software_statement_key_expires_at_idx" ON "software_statement" USING btree ("key_id","expires_at" DESC NULLS LAST);