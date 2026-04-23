use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use du_core::{
    scan_path, ExtensionRow, NodeId, NodeRow, Page, ScanEvent, ScanFailure, ScanOptions,
    ScanSummary, ScanTree, SortSpec, TopKind, VolumeInfo,
};
use serde::{Deserialize, Serialize};
use sysinfo::Disks;
use uuid::Uuid;

pub type ScanNotifier = Box<dyn Fn(ScanEvent) + Send + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    Running,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHandle {
    pub scan_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub scan_id: String,
    pub status: ScanStatus,
    pub stale: bool,
    pub summary: Option<ScanSummary>,
    pub error_message: Option<String>,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    #[error("invalid path: {message}")]
    InvalidPath { message: String },
    #[error("scan not found: {scan_id}")]
    ScanNotFound { scan_id: String },
    #[error("scan is not ready: {scan_id}")]
    ScanNotReady { scan_id: String },
    #[error("invalid node: {message}")]
    InvalidNode { message: String },
    #[error("unsafe path: {message}")]
    UnsafePath { message: String },
    #[error("io error: {message}")]
    Io { message: String },
    #[error("trash error: {message}")]
    Trash { message: String },
    #[error("internal error: {message}")]
    Internal { message: String },
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}

impl From<trash::Error> for AppError {
    fn from(error: trash::Error) -> Self {
        Self::Trash {
            message: error.to_string(),
        }
    }
}

impl From<ScanFailure> for AppError {
    fn from(error: ScanFailure) -> Self {
        match error {
            ScanFailure::InvalidNode(id) => Self::InvalidNode {
                message: format!("node {id} does not exist in this scan"),
            },
            ScanFailure::Metadata { path, source } => Self::InvalidPath {
                message: format!("{}: {source}", path.display()),
            },
        }
    }
}

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<Mutex<StateInner>>,
}

#[derive(Default)]
struct StateInner {
    sessions: HashMap<String, ScanSession>,
}

struct ScanSession {
    scan_id: String,
    cancel: Arc<AtomicBool>,
    status: ScanStatus,
    stale: bool,
    tree: Option<ScanTree>,
    error_message: Option<String>,
}

impl AppState {
    pub fn start_scan(
        &self,
        root: PathBuf,
        options: ScanOptions,
        notifier: Option<ScanNotifier>,
    ) -> Result<ScanHandle, AppError> {
        let root = canonical_scan_root(root)?;
        let scan_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));

        {
            let mut inner = self.lock_inner()?;
            inner.sessions.insert(
                scan_id.clone(),
                ScanSession {
                    scan_id: scan_id.clone(),
                    cancel: Arc::clone(&cancel),
                    status: ScanStatus::Running,
                    stale: false,
                    tree: None,
                    error_message: None,
                },
            );
        }

        let thread_state = self.clone();
        let thread_scan_id = scan_id.clone();
        thread::spawn(move || {
            let result = scan_path(&root, options, Some(cancel.as_ref()), |event| {
                if let Some(notifier) = notifier.as_ref() {
                    notifier(event);
                }
            });

            let Ok(mut inner) = thread_state.inner.lock() else {
                return;
            };
            let Some(session) = inner.sessions.get_mut(&thread_scan_id) else {
                return;
            };

            match result {
                Ok(tree) => {
                    session.status = if tree.summary().cancelled {
                        ScanStatus::Cancelled
                    } else {
                        ScanStatus::Complete
                    };
                    session.tree = Some(tree);
                }
                Err(error) => {
                    session.status = ScanStatus::Failed;
                    session.error_message = Some(error.to_string());
                }
            }
        });

        Ok(ScanHandle { scan_id })
    }

    pub fn cancel_scan(&self, scan_id: &str) -> Result<ScanInfo, AppError> {
        let inner = self.lock_inner()?;
        let session = inner
            .sessions
            .get(scan_id)
            .ok_or_else(|| AppError::ScanNotFound {
                scan_id: scan_id.to_string(),
            })?;
        session.cancel.store(true, Ordering::Relaxed);
        Ok(session_info(session))
    }

    pub fn get_scan_summary(&self, scan_id: &str) -> Result<ScanInfo, AppError> {
        let inner = self.lock_inner()?;
        let session = inner
            .sessions
            .get(scan_id)
            .ok_or_else(|| AppError::ScanNotFound {
                scan_id: scan_id.to_string(),
            })?;
        Ok(session_info(session))
    }

    pub fn get_children(
        &self,
        scan_id: &str,
        node_id: Option<NodeId>,
        sort: SortSpec,
        offset: usize,
        limit: usize,
    ) -> Result<Page<NodeRow>, AppError> {
        self.with_tree(scan_id, |tree| {
            let node_id = node_id.unwrap_or_else(|| tree.root_id());
            tree.children(node_id, sort, offset, limit.min(5_000))
                .map_err(AppError::from)
        })
    }

    pub fn get_top_items(
        &self,
        scan_id: &str,
        kind: TopKind,
        limit: usize,
    ) -> Result<Vec<NodeRow>, AppError> {
        self.with_tree(scan_id, |tree| {
            tree.top_items(kind, limit.min(1_000))
                .map_err(AppError::from)
        })
    }

    pub fn get_extension_breakdown(
        &self,
        scan_id: &str,
        limit: usize,
    ) -> Result<Vec<ExtensionRow>, AppError> {
        self.with_tree(scan_id, |tree| {
            Ok(tree.extension_breakdown(limit.min(1_000)))
        })
    }

    pub fn path_for_node(&self, scan_id: &str, node_id: NodeId) -> Result<PathBuf, AppError> {
        self.with_tree(scan_id, |tree| {
            tree.path_for(node_id).map_err(AppError::from)
        })
    }

    pub fn trash_item(&self, scan_id: &str, node_id: NodeId) -> Result<ScanInfo, AppError> {
        self.trash_item_with(scan_id, node_id, |path| {
            trash::delete(path).map_err(AppError::from)
        })
    }

    pub fn trash_item_with<F>(
        &self,
        scan_id: &str,
        node_id: NodeId,
        delete: F,
    ) -> Result<ScanInfo, AppError>
    where
        F: FnOnce(&Path) -> Result<(), AppError>,
    {
        let path = {
            let inner = self.lock_inner()?;
            let session = inner
                .sessions
                .get(scan_id)
                .ok_or_else(|| AppError::ScanNotFound {
                    scan_id: scan_id.to_string(),
                })?;
            let tree = session
                .tree
                .as_ref()
                .ok_or_else(|| AppError::ScanNotReady {
                    scan_id: scan_id.to_string(),
                })?;
            if node_id == tree.root_id() {
                return Err(AppError::UnsafePath {
                    message: "refusing to trash the scan root".to_string(),
                });
            }
            let path = tree.path_for(node_id).map_err(AppError::from)?;
            if !tree.contains_path(&path) {
                return Err(AppError::UnsafePath {
                    message: format!("{} is outside the scanned root", path.display()),
                });
            }
            path
        };

        delete(&path)?;

        let mut inner = self.lock_inner()?;
        let session = inner
            .sessions
            .get_mut(scan_id)
            .ok_or_else(|| AppError::ScanNotFound {
                scan_id: scan_id.to_string(),
            })?;
        session.stale = true;
        Ok(session_info(session))
    }

    pub fn wait_for_scan_for_test(
        &self,
        scan_id: &str,
        timeout: Duration,
    ) -> Result<ScanInfo, AppError> {
        let started = Instant::now();
        loop {
            let info = self.get_scan_summary(scan_id)?;
            if info.status != ScanStatus::Running {
                return Ok(info);
            }
            if started.elapsed() >= timeout {
                return Err(AppError::Internal {
                    message: format!("timed out waiting for scan {scan_id}"),
                });
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn with_tree<T, F>(&self, scan_id: &str, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&ScanTree) -> Result<T, AppError>,
    {
        let inner = self.lock_inner()?;
        let session = inner
            .sessions
            .get(scan_id)
            .ok_or_else(|| AppError::ScanNotFound {
                scan_id: scan_id.to_string(),
            })?;
        let tree = session
            .tree
            .as_ref()
            .ok_or_else(|| AppError::ScanNotReady {
                scan_id: scan_id.to_string(),
            })?;
        f(tree)
    }

    fn lock_inner(&self) -> Result<MutexGuard<'_, StateInner>, AppError> {
        self.inner.lock().map_err(|error| AppError::Internal {
            message: error.to_string(),
        })
    }
}

pub fn list_volumes() -> Vec<VolumeInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .map(|disk| VolumeInfo {
            name: disk.name().to_string_lossy().to_string(),
            mount_point: disk.mount_point().to_path_buf(),
            file_system: disk.file_system().to_string_lossy().to_string(),
            total_bytes: disk.total_space(),
            available_bytes: disk.available_space(),
            is_removable: disk.is_removable(),
        })
        .collect()
}

fn canonical_scan_root(root: PathBuf) -> Result<PathBuf, AppError> {
    let canonical = root.canonicalize().map_err(|error| AppError::InvalidPath {
        message: format!("{}: {error}", root.display()),
    })?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidPath {
            message: format!("{} is not a directory", canonical.display()),
        });
    }
    Ok(canonical)
}

fn session_info(session: &ScanSession) -> ScanInfo {
    ScanInfo {
        scan_id: session.scan_id.clone(),
        status: session.status,
        stale: session.stale,
        summary: session.tree.as_ref().map(ScanTree::summary),
        error_message: session.error_message.clone(),
    }
}
