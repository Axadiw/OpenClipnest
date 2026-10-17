use std::time::SystemTime;

/// Stat-like metadata for FTP directory listings.
/// Implements `unftp_core::storage::Metadata`.
#[derive(Debug, Clone)]
pub struct ObjectMetadata {
    pub size: u64,
    pub is_dir: bool,
    pub modified: SystemTime,
}

impl ObjectMetadata {
    pub fn directory() -> Self {
        Self {
            size: 0,
            is_dir: true,
            modified: SystemTime::now(),
        }
    }

    /// Constructor that takes the real S3 LastModified instead of stamping
    /// `SystemTime::now()`. FTPS clients (lftp, FileZilla) display this
    /// timestamp in their listing — without the real value every file in
    /// every LIST shows the time of the listing, which made it look like
    /// every recording was uploaded "just now".
    pub fn file_with_modified(size: u64, modified: Option<SystemTime>) -> Self {
        Self {
            size,
            is_dir: false,
            modified: modified.unwrap_or_else(SystemTime::now),
        }
    }
}

impl unftp_core::storage::Metadata for ObjectMetadata {
    fn len(&self) -> u64 {
        self.size
    }

    fn is_dir(&self) -> bool {
        self.is_dir
    }

    fn is_file(&self) -> bool {
        !self.is_dir
    }

    fn is_symlink(&self) -> bool {
        false
    }

    fn modified(&self) -> unftp_core::storage::Result<SystemTime> {
        Ok(self.modified)
    }

    fn gid(&self) -> u32 {
        1
    }

    fn uid(&self) -> u32 {
        1
    }
}
