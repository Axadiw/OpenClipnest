use std::fmt;
use std::path::Path;
use unftp_core::auth::UserDetail;

/// Per-session user context carrying the data needed for S3 operations.
///
/// `Debug` redacts both `username` (email — PII) and `encryption_salt`. Libunftp's
/// `tracing` subsystem captures the whole session context on command-level WARN
/// records via the implicit `self = ?` instrument field; without this redaction
/// every rejected upload writes the operator's email + salt to journald and to
/// any downstream log aggregator. `user_uuid` stays visible — it's the same
/// value already used as the S3 key prefix, and ops needs SOMETHING to
/// correlate a log line with a user. Both `encryption_salt` and `username`
/// (the email) are redacted.
#[derive(Clone)]
pub struct ClipnestUser {
    /// Kept on the struct for parity with libunftp's `Principal.username`
    /// (the authenticator constructs both from the same source) and as the
    /// cache key in `auth.rs`. Never read for logging —
    /// every log site moved to `user_uuid` and the `Debug` impl prints
    /// `<redacted>` rather than this field.
    #[allow(dead_code)]
    pub username: String,
    pub user_uuid: String,
    pub encryption_salt: String,
}

impl fmt::Debug for ClipnestUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClipnestUser")
            .field("username", &"<redacted>")
            .field("user_uuid", &self.user_uuid)
            .field("encryption_salt", &"<redacted>")
            .finish()
    }
}

impl fmt::Display for ClipnestUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<user {}>", self.user_uuid)
    }
}

impl UserDetail for ClipnestUser {
    fn account_enabled(&self) -> bool {
        true
    }

    fn home(&self) -> Option<&Path> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    ///story: Debug-format `ClipnestUser` nigdy nie ujawnia `encryption_salt` ani `username` (email = PII) — regresje: wyciek soli + wyciek emaila. `user_uuid` zostaje widoczny dla ops.
    #[test]
    fn debug_format_redacts_secret_fields() {
        // Regression test for two leaks:
        //   - #[derive(Debug)] leaked per-user
        //     encryption salts into journald on every libunftp WARN.
        //   - the leftover `username`
        //     field (which IS the user's email) leaked PII into journald +
        //     any downstream log pipeline on every rejected upload.
        let user = ClipnestUser {
            username: "alice@example.com".to_string(),
            user_uuid: "f24450a4-ff34-4052-8eb5-52699a1e9905".to_string(),
            encryption_salt: "NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA".to_string(),
        };
        let dbg = format!("{:?}", user);
        assert!(
            !dbg.contains("NhCZ0UA_ZkzbyUULKUDjAbhVoXlvrVSzdsYxtE44KVA"),
            "Debug impl leaked encryption_salt: {}",
            dbg,
        );
        assert!(
            !dbg.contains("alice@example.com"),
            "Debug impl leaked username (email is PII): {}",
            dbg,
        );
        assert!(dbg.contains("<redacted>"), "Debug impl must mark the redaction");
        // user_uuid stays visible so ops can correlate log lines without PII.
        assert!(dbg.contains("f24450a4"), "user_uuid must remain in Debug output");
    }

    ///story: Display-format `ClipnestUser` nie ujawnia email (był używany w `Display` wcześniej).
    #[test]
    fn display_format_does_not_leak_username() {
        let user = ClipnestUser {
            username: "bob@example.com".to_string(),
            user_uuid: "11111111-2222-3333-4444-555555555555".to_string(),
            encryption_salt: "salt".to_string(),
        };
        let s = format!("{}", user);
        assert!(!s.contains("bob@example.com"), "Display leaked email: {}", s);
        assert!(s.contains("11111111"), "Display should still carry user_uuid: {}", s);
    }
}
