CREATE TABLE public.email_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash text NOT NULL,
    kind text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_tokens_kind_check CHECK ((kind = ANY (ARRAY['verify'::text, 'reset'::text, 'delete-account'::text])))
);
CREATE SEQUENCE public.email_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.email_tokens_id_seq OWNED BY public.email_tokens.id;
CREATE TABLE public.event_view_files (
    event_id text NOT NULL,
    view_id text NOT NULL,
    video_rel_path text NOT NULL,
    duration_ms bigint,
    size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    frame_rate real
);
CREATE TABLE public.events (
    id text NOT NULL,
    camera text NOT NULL,
    "timestamp" text NOT NULL,
    date text NOT NULL,
    thumbnail text,
    duration real,
    owner_id integer,
    thumbnail_attempts integer DEFAULT 0 NOT NULL,
    playback_ready boolean DEFAULT false NOT NULL,
    playback_unplayable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.file_metadata (
    id integer NOT NULL,
    owner_id integer NOT NULL,
    s3_bucket text NOT NULL,
    s3_key text NOT NULL,
    original_filename text NOT NULL,
    file_size_bytes bigint NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_state text DEFAULT 'pending_sidecar'::text NOT NULL,
    next_retry_at timestamp with time zone,
    processing_attempts integer DEFAULT 0 NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    CONSTRAINT file_metadata_processing_state_check CHECK ((processing_state = ANY (ARRAY['pending_sidecar'::text, 'ready'::text, 'unplayable'::text, 'duplicate'::text, 'unrecognized'::text, 'not_applicable'::text])))
);
CREATE SEQUENCE public.file_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.file_metadata_id_seq OWNED BY public.file_metadata.id;
CREATE TABLE public.invite_codes (
    id integer NOT NULL,
    code text NOT NULL,
    plan_id integer NOT NULL,
    note text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone,
    used_by integer,
    revoked_at timestamp with time zone
);
CREATE SEQUENCE public.invite_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.invite_codes_id_seq OWNED BY public.invite_codes.id;
CREATE TABLE public.ip_login_attempts (
    source_ip inet NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    lockout_count integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.mcp_audit_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    client_id uuid,
    action text NOT NULL,
    details_json jsonb NOT NULL,
    ip inet
);
CREATE SEQUENCE public.mcp_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.mcp_audit_log_id_seq OWNED BY public.mcp_audit_log.id;
CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    message text NOT NULL,
    details jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;
CREATE TABLE public.oauth_access_tokens (
    token_hash bytea NOT NULL,
    client_id uuid NOT NULL,
    user_id integer NOT NULL,
    scope text NOT NULL,
    family_id uuid NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    token_generation integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.oauth_authorization_codes (
    code_hash bytea NOT NULL,
    client_id uuid NOT NULL,
    user_id integer NOT NULL,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    code_challenge text NOT NULL,
    resource text NOT NULL,
    consumed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    family_id uuid NOT NULL
);
CREATE TABLE public.oauth_authorization_txns (
    txn_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    scope text NOT NULL,
    state text NOT NULL,
    code_challenge text NOT NULL,
    code_challenge_method text DEFAULT 'S256'::text NOT NULL,
    resource text NOT NULL,
    user_id integer,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_authorization_txns_code_challenge_method_check CHECK ((code_challenge_method = 'S256'::text))
);
CREATE TABLE public.oauth_clients (
    client_id uuid NOT NULL,
    client_name text NOT NULL,
    redirect_uris text[] NOT NULL,
    software_id text,
    software_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id integer,
    revoked_at timestamp with time zone
);
CREATE TABLE public.oauth_refresh_tokens (
    token_hash bytea NOT NULL,
    client_id uuid NOT NULL,
    user_id integer NOT NULL,
    scope text NOT NULL,
    family_id uuid NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    rotated_to bytea,
    revoked_at timestamp with time zone,
    token_generation integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.passkey_backup_codes (
    id integer NOT NULL,
    user_id integer NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.passkey_backup_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.passkey_backup_codes_id_seq OWNED BY public.passkey_backup_codes.id;
CREATE TABLE public.passkeys (
    id integer NOT NULL,
    user_id integer NOT NULL,
    credential_id text NOT NULL,
    public_key bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text,
    device_name text,
    aaguid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);
CREATE SEQUENCE public.passkeys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.passkeys_id_seq OWNED BY public.passkeys.id;
CREATE TABLE public.plans (
    id integer NOT NULL,
    name text NOT NULL,
    disk_space_bytes bigint NOT NULL,
    monthly_transfer_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.plans_id_seq OWNED BY public.plans.id;
CREATE TABLE public.push_devices (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    device_token text NOT NULL,
    platform text NOT NULL,
    environment text DEFAULT 'production'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    supports_loc_keys boolean DEFAULT false NOT NULL,
    relay_device_id text,
    public_key text
);
CREATE SEQUENCE public.push_devices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.push_devices_id_seq OWNED BY public.push_devices.id;
CREATE TABLE public.push_prefs (
    user_id integer NOT NULL,
    snooze_until timestamp with time zone,
    categories jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL
);
CREATE TABLE public.storage_disk_corrections (
    id integer NOT NULL,
    run_id integer NOT NULL,
    user_id integer NOT NULL,
    email text NOT NULL,
    old_bytes bigint NOT NULL,
    new_bytes bigint NOT NULL,
    delta_bytes bigint NOT NULL,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE public.storage_disk_corrections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.storage_disk_corrections_id_seq OWNED BY public.storage_disk_corrections.id;
CREATE TABLE public.storage_orphan_objects (
    id integer NOT NULL,
    s3_bucket text NOT NULL,
    s3_key text NOT NULL,
    size_bytes bigint NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    seen_count integer DEFAULT 1 NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by integer
);
CREATE SEQUENCE public.storage_orphan_objects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.storage_orphan_objects_id_seq OWNED BY public.storage_orphan_objects.id;
CREATE TABLE public.storage_reconciliation_runs (
    id integer NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    users_checked integer DEFAULT 0 NOT NULL,
    corrections_made integer DEFAULT 0 NOT NULL,
    orphans_found integer DEFAULT 0 NOT NULL,
    orphan_bytes_total bigint DEFAULT 0 NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    zombies_cleaned integer DEFAULT 0 NOT NULL,
    zombies_remaining integer DEFAULT 0 NOT NULL,
    events_reconciled integer DEFAULT 0 NOT NULL,
    events_deleted integer DEFAULT 0 NOT NULL
);
CREATE SEQUENCE public.storage_reconciliation_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.storage_reconciliation_runs_id_seq OWNED BY public.storage_reconciliation_runs.id;
CREATE TABLE public.tv_device_codes (
    id integer NOT NULL,
    user_code text NOT NULL,
    device_code text NOT NULL,
    user_id integer,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text
);
CREATE SEQUENCE public.tv_device_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.tv_device_codes_id_seq OWNED BY public.tv_device_codes.id;
CREATE TABLE public.upload_events (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    bytes bigint NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_events_bytes_check CHECK ((bytes >= 0))
);
CREATE SEQUENCE public.upload_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.upload_events_id_seq OWNED BY public.upload_events.id;
CREATE TABLE public.user_appeals (
    id integer NOT NULL,
    user_email text NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    body text NOT NULL,
    ip text,
    user_agent text,
    decision text,
    decided_at timestamp with time zone,
    decided_by integer
);
CREATE SEQUENCE public.user_appeals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.user_appeals_id_seq OWNED BY public.user_appeals.id;
CREATE TABLE public.user_bans (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type text NOT NULL,
    reason text,
    issued_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    cancelled_at timestamp with time zone,
    source_ip inet,
    channel text,
    CONSTRAINT user_bans_channel_check CHECK ((channel = ANY (ARRAY['web'::text, 'ftp'::text]))),
    CONSTRAINT user_bans_type_check CHECK ((type = ANY (ARRAY['manual'::text, 'lockout'::text])))
);
CREATE SEQUENCE public.user_bans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.user_bans_id_seq OWNED BY public.user_bans.id;
CREATE TABLE public.user_camera_profiles (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    regex text NOT NULL,
    view_default text DEFAULT '00'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    views_config jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT user_camera_profiles_view_default_check CHECK (((length(view_default) >= 1) AND (length(view_default) <= 16)))
);
CREATE SEQUENCE public.user_camera_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.user_camera_profiles_id_seq OWNED BY public.user_camera_profiles.id;
CREATE TABLE public.user_identities (
    id integer NOT NULL,
    user_id integer NOT NULL,
    provider text NOT NULL,
    subject text NOT NULL,
    email public.citext,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);
CREATE SEQUENCE public.user_identities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.user_identities_id_seq OWNED BY public.user_identities.id;
CREATE TABLE public.user_scan_state (
    user_id integer NOT NULL,
    last_scanned_at timestamp with time zone NOT NULL,
    last_seen_s3_key text,
    full_rescan_due_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.users (
    id integer NOT NULL,
    uuid text NOT NULL,
    email public.citext NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    password_hash text,
    is_admin boolean DEFAULT false NOT NULL,
    plan_id integer,
    encryption_salt text,
    disk_usage_bytes bigint DEFAULT 0 NOT NULL,
    transfer_usage_bytes bigint DEFAULT 0 NOT NULL,
    transfer_reset_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    token_generation integer DEFAULT 0 NOT NULL,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    lockout_count integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    auto_delete_oldest boolean DEFAULT false NOT NULL,
    accepted_terms_at timestamp with time zone,
    newsletter_consent boolean DEFAULT false NOT NULL,
    marketing_consent boolean DEFAULT false NOT NULL,
    auto_delete_after_days integer,
    storage_warn_email_sent_at timestamp with time zone,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    upload_lifetime_bytes bigint DEFAULT 0 NOT NULL,
    deletion_status text DEFAULT 'active'::text NOT NULL,
    deletion_started_at timestamp with time zone,
    passkey_enabled boolean DEFAULT false NOT NULL,
    ftps_password_hash text,
    camera_profile_mode text DEFAULT 'auto'::text NOT NULL,
    upload_30d_bytes bigint DEFAULT 0 NOT NULL,
    ftp_failed_login_attempts integer DEFAULT 0 NOT NULL,
    ftp_lockout_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT users_camera_profile_mode_check CHECK ((camera_profile_mode = ANY (ARRAY['auto'::text, 'reolink'::text, 'hikvision'::text, 'axis'::text, 'foscam'::text, 'custom'::text])))
);
CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;
ALTER TABLE ONLY public.email_tokens ALTER COLUMN id SET DEFAULT nextval('public.email_tokens_id_seq'::regclass);
ALTER TABLE ONLY public.file_metadata ALTER COLUMN id SET DEFAULT nextval('public.file_metadata_id_seq'::regclass);
ALTER TABLE ONLY public.invite_codes ALTER COLUMN id SET DEFAULT nextval('public.invite_codes_id_seq'::regclass);
ALTER TABLE ONLY public.mcp_audit_log ALTER COLUMN id SET DEFAULT nextval('public.mcp_audit_log_id_seq'::regclass);
ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);
ALTER TABLE ONLY public.passkey_backup_codes ALTER COLUMN id SET DEFAULT nextval('public.passkey_backup_codes_id_seq'::regclass);
ALTER TABLE ONLY public.passkeys ALTER COLUMN id SET DEFAULT nextval('public.passkeys_id_seq'::regclass);
ALTER TABLE ONLY public.plans ALTER COLUMN id SET DEFAULT nextval('public.plans_id_seq'::regclass);
ALTER TABLE ONLY public.push_devices ALTER COLUMN id SET DEFAULT nextval('public.push_devices_id_seq'::regclass);
ALTER TABLE ONLY public.storage_disk_corrections ALTER COLUMN id SET DEFAULT nextval('public.storage_disk_corrections_id_seq'::regclass);
ALTER TABLE ONLY public.storage_orphan_objects ALTER COLUMN id SET DEFAULT nextval('public.storage_orphan_objects_id_seq'::regclass);
ALTER TABLE ONLY public.storage_reconciliation_runs ALTER COLUMN id SET DEFAULT nextval('public.storage_reconciliation_runs_id_seq'::regclass);
ALTER TABLE ONLY public.tv_device_codes ALTER COLUMN id SET DEFAULT nextval('public.tv_device_codes_id_seq'::regclass);
ALTER TABLE ONLY public.upload_events ALTER COLUMN id SET DEFAULT nextval('public.upload_events_id_seq'::regclass);
ALTER TABLE ONLY public.user_appeals ALTER COLUMN id SET DEFAULT nextval('public.user_appeals_id_seq'::regclass);
ALTER TABLE ONLY public.user_bans ALTER COLUMN id SET DEFAULT nextval('public.user_bans_id_seq'::regclass);
ALTER TABLE ONLY public.user_camera_profiles ALTER COLUMN id SET DEFAULT nextval('public.user_camera_profiles_id_seq'::regclass);
ALTER TABLE ONLY public.user_identities ALTER COLUMN id SET DEFAULT nextval('public.user_identities_id_seq'::regclass);
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_token_hash_unique UNIQUE (token_hash);
ALTER TABLE ONLY public.event_view_files
    ADD CONSTRAINT event_view_files_event_id_view_id_pk PRIMARY KEY (event_id, view_id);
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.file_metadata
    ADD CONSTRAINT file_metadata_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_code_unique UNIQUE (code);
ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ip_login_attempts
    ADD CONSTRAINT ip_login_attempts_pkey PRIMARY KEY (source_ip);
ALTER TABLE ONLY public.mcp_audit_log
    ADD CONSTRAINT mcp_audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_pkey PRIMARY KEY (token_hash);
ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (code_hash);
ALTER TABLE ONLY public.oauth_authorization_txns
    ADD CONSTRAINT oauth_authorization_txns_pkey PRIMARY KEY (txn_id);
ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);
ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_pkey PRIMARY KEY (token_hash);
ALTER TABLE ONLY public.passkey_backup_codes
    ADD CONSTRAINT passkey_backup_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_credential_id_unique UNIQUE (credential_id);
ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_name_unique UNIQUE (name);
ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_device_token_unique UNIQUE (device_token);
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.push_prefs
    ADD CONSTRAINT push_prefs_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);
ALTER TABLE ONLY public.storage_disk_corrections
    ADD CONSTRAINT storage_disk_corrections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.storage_orphan_objects
    ADD CONSTRAINT storage_orphan_objects_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.storage_reconciliation_runs
    ADD CONSTRAINT storage_reconciliation_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tv_device_codes
    ADD CONSTRAINT tv_device_codes_device_code_unique UNIQUE (device_code);
ALTER TABLE ONLY public.tv_device_codes
    ADD CONSTRAINT tv_device_codes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.tv_device_codes
    ADD CONSTRAINT tv_device_codes_user_code_unique UNIQUE (user_code);
ALTER TABLE ONLY public.upload_events
    ADD CONSTRAINT upload_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_appeals
    ADD CONSTRAINT user_appeals_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_bans
    ADD CONSTRAINT user_bans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_camera_profiles
    ADD CONSTRAINT user_camera_profiles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.user_scan_state
    ADD CONSTRAINT user_scan_state_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_uuid_unique UNIQUE (uuid);
CREATE UNIQUE INDEX file_metadata_s3_bucket_s3_key_key ON public.file_metadata USING btree (s3_bucket, s3_key);
CREATE INDEX idx_audit_action_ts ON public.mcp_audit_log USING btree (action, ts DESC NULLS LAST);
CREATE INDEX idx_audit_user_ts ON public.mcp_audit_log USING btree (user_id, ts DESC NULLS LAST);
CREATE INDEX idx_disk_corrections_run ON public.storage_disk_corrections USING btree (run_id);
CREATE INDEX idx_disk_corrections_user ON public.storage_disk_corrections USING btree (user_id);
CREATE INDEX idx_email_tokens_cleanup ON public.email_tokens USING btree (expires_at) WHERE (used_at IS NULL);
CREATE INDEX idx_email_tokens_user ON public.email_tokens USING btree (user_id);
CREATE INDEX idx_event_view_files_event ON public.event_view_files USING btree (event_id);
CREATE INDEX idx_event_view_files_path ON public.event_view_files USING btree (video_rel_path);
CREATE INDEX idx_events_camera ON public.events USING btree (camera);
CREATE INDEX idx_events_owner ON public.events USING btree (owner_id);
CREATE INDEX idx_events_owner_camera ON public.events USING btree (owner_id, camera);
CREATE INDEX idx_events_timestamp ON public.events USING btree ("timestamp" DESC NULLS LAST);
CREATE INDEX idx_file_metadata_owner ON public.file_metadata USING btree (owner_id);
CREATE INDEX idx_file_metadata_owner_s3key ON public.file_metadata USING btree (owner_id, s3_key);
CREATE INDEX idx_file_metadata_owner_state_pending ON public.file_metadata USING btree (owner_id) WHERE (processing_state = 'pending_sidecar'::text);
CREATE INDEX idx_file_metadata_owner_uploaded ON public.file_metadata USING btree (owner_id, uploaded_at);
CREATE INDEX idx_file_metadata_redrive ON public.file_metadata USING btree (next_retry_at) WHERE (processing_state = 'pending_sidecar'::text);
CREATE INDEX idx_file_metadata_unrecognized_retry ON public.file_metadata USING btree (next_retry_at) WHERE ((processing_state = 'unrecognized'::text) AND (next_retry_at IS NOT NULL));
CREATE INDEX idx_invite_codes_available ON public.invite_codes USING btree (plan_id) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
CREATE INDEX idx_invite_codes_used_by ON public.invite_codes USING btree (used_by) WHERE (used_by IS NOT NULL);
CREATE INDEX idx_notifications_user_created ON public.notifications USING btree (user_id, created_at DESC NULLS LAST);
CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);
CREATE INDEX idx_oauth_access_tokens_expires ON public.oauth_access_tokens USING btree (expires_at);
CREATE INDEX idx_oauth_access_tokens_family ON public.oauth_access_tokens USING btree (family_id);
CREATE INDEX idx_oauth_access_tokens_user ON public.oauth_access_tokens USING btree (user_id);
CREATE INDEX idx_oauth_clients_user ON public.oauth_clients USING btree (created_by_user_id);
CREATE INDEX idx_oauth_codes_expires ON public.oauth_authorization_codes USING btree (expires_at);
CREATE INDEX idx_oauth_refresh_tokens_expires ON public.oauth_refresh_tokens USING btree (expires_at);
CREATE INDEX idx_oauth_refresh_tokens_family ON public.oauth_refresh_tokens USING btree (family_id);
CREATE INDEX idx_oauth_txns_created ON public.oauth_authorization_txns USING btree (created_at);
CREATE INDEX idx_orphans_acknowledged ON public.storage_orphan_objects USING btree (acknowledged);
CREATE INDEX idx_passkey_backup_codes_user ON public.passkey_backup_codes USING btree (user_id) WHERE (used_at IS NULL);
CREATE INDEX idx_passkeys_user ON public.passkeys USING btree (user_id);
CREATE INDEX idx_push_devices_user ON public.push_devices USING btree (user_id);
CREATE INDEX idx_tv_device_codes_expires ON public.tv_device_codes USING btree (expires_at);
CREATE INDEX idx_upload_events_uploaded_at ON public.upload_events USING btree (uploaded_at);
CREATE INDEX idx_upload_events_user_time ON public.upload_events USING btree (user_id, uploaded_at DESC NULLS LAST);
CREATE INDEX idx_user_appeals_email ON public.user_appeals USING btree (user_email, submitted_at DESC NULLS LAST);
CREATE INDEX idx_user_bans_active ON public.user_bans USING btree (user_id, expires_at) WHERE (cancelled_at IS NULL);
CREATE INDEX idx_user_bans_ip_active ON public.user_bans USING btree (source_ip, expires_at) WHERE (cancelled_at IS NULL);
CREATE INDEX idx_user_camera_profiles_user_priority ON public.user_camera_profiles USING btree (user_id, priority);
CREATE INDEX idx_user_identities_user ON public.user_identities USING btree (user_id);
CREATE INDEX idx_users_deletion_status ON public.users USING btree (deletion_status) WHERE (deletion_status <> 'active'::text);
CREATE UNIQUE INDEX storage_orphan_objects_s3_bucket_s3_key_key ON public.storage_orphan_objects USING btree (s3_bucket, s3_key);
CREATE UNIQUE INDEX user_identities_provider_subject_key ON public.user_identities USING btree (provider, subject);
ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.event_view_files
    ADD CONSTRAINT event_view_files_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.file_metadata
    ADD CONSTRAINT file_metadata_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id);
ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_used_by_users_id_fk FOREIGN KEY (used_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.mcp_audit_log
    ADD CONSTRAINT mcp_audit_log_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE SET NULL;
ALTER TABLE ONLY public.mcp_audit_log
    ADD CONSTRAINT mcp_audit_log_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_authorization_txns
    ADD CONSTRAINT oauth_authorization_txns_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_authorization_txns
    ADD CONSTRAINT oauth_authorization_txns_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_created_by_user_id_users_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.passkey_backup_codes
    ADD CONSTRAINT passkey_backup_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.passkeys
    ADD CONSTRAINT passkeys_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_devices
    ADD CONSTRAINT push_devices_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.push_prefs
    ADD CONSTRAINT push_prefs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.storage_disk_corrections
    ADD CONSTRAINT storage_disk_corrections_run_id_storage_reconciliation_runs_id_ FOREIGN KEY (run_id) REFERENCES public.storage_reconciliation_runs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.storage_disk_corrections
    ADD CONSTRAINT storage_disk_corrections_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.storage_orphan_objects
    ADD CONSTRAINT storage_orphan_objects_acknowledged_by_users_id_fk FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.tv_device_codes
    ADD CONSTRAINT tv_device_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.upload_events
    ADD CONSTRAINT upload_events_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_appeals
    ADD CONSTRAINT user_appeals_decided_by_users_id_fk FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.user_bans
    ADD CONSTRAINT user_bans_issued_by_users_id_fk FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.user_bans
    ADD CONSTRAINT user_bans_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_camera_profiles
    ADD CONSTRAINT user_camera_profiles_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.user_scan_state
    ADD CONSTRAINT user_scan_state_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_plan_id_plans_id_fk FOREIGN KEY (plan_id) REFERENCES public.plans(id);
