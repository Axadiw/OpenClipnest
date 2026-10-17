-- A: per-file frame rate for frame stepping (web seeks by 1/fps)
ALTER TABLE event_view_files ADD COLUMN frame_rate real;--> statement-breakpoint

-- B: OAuth identities (Google / Apple sign-in)
CREATE TABLE user_identities (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    subject text NOT NULL,
    email citext,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX user_identities_provider_subject_key ON user_identities(provider, subject);--> statement-breakpoint
CREATE INDEX idx_user_identities_user ON user_identities(user_id);--> statement-breakpoint

-- B: OAuth-only accounts have no password
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
