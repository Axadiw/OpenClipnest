ALTER TABLE "user_camera_profiles" ADD COLUMN "views_config" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Backfill: every pre-feature row (still at the '[]' default) becomes a
-- single-view config carrying its lens_default + a generic icon. Idempotent
-- — the WHERE guard skips rows already populated by a write since the column
-- was added.
UPDATE user_camera_profiles
   SET views_config = jsonb_build_array(
         jsonb_build_object('id', lens_default, 'iconKind', 'generic')
       )
 WHERE views_config = '[]'::jsonb;