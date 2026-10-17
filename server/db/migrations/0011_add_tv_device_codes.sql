CREATE TABLE "tv_device_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code" text NOT NULL,
	"user_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tv_device_codes_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "tv_device_codes_device_code_unique" UNIQUE("device_code")
);
--> statement-breakpoint
ALTER TABLE "tv_device_codes" ADD CONSTRAINT "tv_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tv_device_codes_expires" ON "tv_device_codes" USING btree ("expires_at");