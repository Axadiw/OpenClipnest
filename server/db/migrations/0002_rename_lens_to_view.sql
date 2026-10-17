-- Rename lens → view. Idempotent + constraint-name-agnostic: a fresh DB built
-- from the drizzle baseline has drizzle-convention names
-- (event_lens_files_event_id_lens_id_pk / …_event_id_events_id_fk), while prod
-- (baselined out-of-band) has Postgres-default names (event_lens_files_pkey /
-- event_lens_files_event_id_fkey). Each step renames whichever name exists and
-- no-ops if the rename already happened, so this applies cleanly on a fresh DB,
-- on prod, and on a re-apply.
ALTER TABLE IF EXISTS "event_lens_files" RENAME TO "event_view_files";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'event_view_files'::regclass AND attname = 'lens_id' AND NOT attisdropped) THEN
    ALTER TABLE "event_view_files" RENAME COLUMN "lens_id" TO "view_id";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'event_view_files'::regclass AND conname = 'event_lens_files_event_id_lens_id_pk') THEN
    ALTER TABLE "event_view_files" RENAME CONSTRAINT "event_lens_files_event_id_lens_id_pk" TO "event_view_files_event_id_view_id_pk";
  ELSIF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'event_view_files'::regclass AND conname = 'event_lens_files_pkey') THEN
    ALTER TABLE "event_view_files" RENAME CONSTRAINT "event_lens_files_pkey" TO "event_view_files_event_id_view_id_pk";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'event_view_files'::regclass AND conname = 'event_lens_files_event_id_events_id_fk') THEN
    ALTER TABLE "event_view_files" RENAME CONSTRAINT "event_lens_files_event_id_events_id_fk" TO "event_view_files_event_id_events_id_fk";
  ELSIF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'event_view_files'::regclass AND conname = 'event_lens_files_event_id_fkey') THEN
    ALTER TABLE "event_view_files" RENAME CONSTRAINT "event_lens_files_event_id_fkey" TO "event_view_files_event_id_events_id_fk";
  END IF;
END $$;--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_event_lens_files_event" RENAME TO "idx_event_view_files_event";--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_event_lens_files_path" RENAME TO "idx_event_view_files_path";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'user_camera_profiles'::regclass AND attname = 'lens_default' AND NOT attisdropped) THEN
    ALTER TABLE "user_camera_profiles" RENAME COLUMN "lens_default" TO "view_default";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'user_camera_profiles'::regclass AND conname = 'user_camera_profiles_lens_default_check') THEN
    ALTER TABLE "user_camera_profiles" RENAME CONSTRAINT "user_camera_profiles_lens_default_check" TO "user_camera_profiles_view_default_check";
  END IF;
END $$;
