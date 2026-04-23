use std::cmp::Ordering as CmpOrdering;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub u32);

impl NodeId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortBy {
    Name,
    LogicalBytes,
    AllocatedBytes,
    Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub by: SortBy,
    pub direction: SortDirection,
}

impl Default for SortSpec {
    fn default() -> Self {
        Self {
            by: SortBy::Name,
            direction: SortDirection::Asc,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TopKind {
    Files,
    Directories,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    pub include_hidden: bool,
    pub stay_on_filesystem: bool,
    pub follow_symlinks: bool,
    pub compute_allocated: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            include_hidden: true,
            stay_on_filesystem: false,
            follow_symlinks: false,
            compute_allocated: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub root: PathBuf,
    pub total_logical_bytes: u64,
    pub total_allocated_bytes: Option<u64>,
    pub file_count: u64,
    pub directory_count: u64,
    pub symlink_count: u64,
    pub error_count: usize,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanError {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub mount_point: PathBuf,
    pub file_system: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub is_removable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub id: NodeId,
    pub name: String,
    pub path: PathBuf,
    pub kind: NodeKind,
    pub logical_bytes: u64,
    pub allocated_bytes: Option<u64>,
    pub file_count: u64,
    pub directory_count: u64,
    pub symlink_count: u64,
    pub child_count: usize,
    pub percent_of_root: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRow {
    pub extension: String,
    pub logical_bytes: u64,
    pub allocated_bytes: Option<u64>,
    pub file_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    Started {
        root: PathBuf,
    },
    Progress {
        entries_scanned: u64,
        bytes_scanned: u64,
        current_path: PathBuf,
    },
    Error {
        path: PathBuf,
        message: String,
    },
    Completed {
        summary: ScanSummary,
    },
    Cancelled {
        summary: ScanSummary,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ScanFailure {
    #[error("failed to read metadata for {path}: {source}")]
    Metadata {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid node id {0}")]
    InvalidNode(NodeId),
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub name: String,
    pub parent: Option<NodeId>,
    pub kind: NodeKind,
    pub children: Vec<NodeId>,
    pub own_logical_bytes: u64,
    pub own_allocated_bytes: Option<u64>,
    pub logical_bytes: u64,
    pub allocated_bytes: Option<u64>,
    pub file_count: u64,
    pub directory_count: u64,
    pub symlink_count: u64,
}

#[derive(Debug, Clone)]
pub struct ScanTree {
    root: NodeId,
    root_path: PathBuf,
    nodes: Vec<Node>,
    errors: Vec<ScanError>,
    cancelled: bool,
}

impl ScanTree {
    pub fn root_id(&self) -> NodeId {
        self.root
    }

    pub fn errors(&self) -> &[ScanError] {
        &self.errors
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id.index()).filter(|node| node.id == id)
    }

    pub fn summary(&self) -> ScanSummary {
        let root = &self.nodes[self.root.index()];
        ScanSummary {
            root: self.root_path.clone(),
            total_logical_bytes: root.logical_bytes,
            total_allocated_bytes: root.allocated_bytes,
            file_count: root.file_count,
            directory_count: root.directory_count,
            symlink_count: root.symlink_count,
            error_count: self.errors.len(),
            cancelled: self.cancelled,
        }
    }

    pub fn children(
        &self,
        parent: NodeId,
        sort: SortSpec,
        offset: usize,
        limit: usize,
    ) -> Result<Page<NodeRow>, ScanFailure> {
        let parent_node = self.node(parent).ok_or(ScanFailure::InvalidNode(parent))?;
        let mut child_ids = parent_node.children.clone();
        self.sort_node_ids(&mut child_ids, sort);

        let total = child_ids.len();
        let items = child_ids
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|id| self.row_for(id))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Page {
            items,
            total,
            offset,
            limit,
        })
    }

    pub fn top_items(&self, kind: TopKind, limit: usize) -> Result<Vec<NodeRow>, ScanFailure> {
        let mut ids = self
            .nodes
            .iter()
            .filter(|node| match kind {
                TopKind::Files => node.kind == NodeKind::File,
                TopKind::Directories => node.kind == NodeKind::Directory && node.id != self.root,
            })
            .map(|node| node.id)
            .collect::<Vec<_>>();

        self.sort_node_ids(
            &mut ids,
            SortSpec {
                by: SortBy::LogicalBytes,
                direction: SortDirection::Desc,
            },
        );

        ids.into_iter()
            .take(limit)
            .map(|id| self.row_for(id))
            .collect()
    }

    pub fn extension_breakdown(&self, limit: usize) -> Vec<ExtensionRow> {
        let mut by_extension = HashMap::<String, ExtensionAccumulator>::new();

        for node in self.nodes.iter().filter(|node| node.kind == NodeKind::File) {
            let extension = Path::new(&node.name)
                .extension()
                .and_then(OsStr::to_str)
                .map(|extension| extension.to_ascii_lowercase())
                .filter(|extension| !extension.is_empty())
                .unwrap_or_else(|| "no extension".to_string());
            let entry = by_extension.entry(extension).or_default();
            entry.logical_bytes = entry.logical_bytes.saturating_add(node.logical_bytes);
            entry.allocated_bytes = merge_allocated(entry.allocated_bytes, node.allocated_bytes);
            entry.file_count += 1;
        }

        let mut rows = by_extension
            .into_iter()
            .map(|(extension, row)| ExtensionRow {
                extension,
                logical_bytes: row.logical_bytes,
                allocated_bytes: row.allocated_bytes,
                file_count: row.file_count,
            })
            .collect::<Vec<_>>();

        rows.sort_by(|left, right| {
            right
                .logical_bytes
                .cmp(&left.logical_bytes)
                .then_with(|| left.extension.cmp(&right.extension))
        });
        rows.truncate(limit);
        rows
    }

    pub fn path_for(&self, id: NodeId) -> Result<PathBuf, ScanFailure> {
        let mut node = self.node(id).ok_or(ScanFailure::InvalidNode(id))?;
        if node.id == self.root {
            return Ok(self.root_path.clone());
        }

        let mut names = vec![node.name.clone()];
        while let Some(parent_id) = node.parent {
            node = self
                .node(parent_id)
                .ok_or(ScanFailure::InvalidNode(parent_id))?;
            if node.id != self.root {
                names.push(node.name.clone());
            }
        }

        let mut path = self.root_path.clone();
        for name in names.into_iter().rev() {
            path.push(name);
        }
        Ok(path)
    }

    pub fn contains_path(&self, path: &Path) -> bool {
        let Ok(target) = path.canonicalize() else {
            return false;
        };
        let Ok(root) = self.root_path.canonicalize() else {
            return false;
        };
        target == root || target.starts_with(root)
    }

    fn row_for(&self, id: NodeId) -> Result<NodeRow, ScanFailure> {
        let node = self.node(id).ok_or(ScanFailure::InvalidNode(id))?;
        let root_logical = self.nodes[self.root.index()].logical_bytes;
        let percent_of_root = if root_logical == 0 {
            0.0
        } else {
            (node.logical_bytes as f64 / root_logical as f64) * 100.0
        };

        Ok(NodeRow {
            id,
            name: node.name.clone(),
            path: self.path_for(id)?,
            kind: node.kind,
            logical_bytes: node.logical_bytes,
            allocated_bytes: node.allocated_bytes,
            file_count: node.file_count,
            directory_count: node.directory_count,
            symlink_count: node.symlink_count,
            child_count: node.children.len(),
            percent_of_root,
        })
    }

    fn sort_node_ids(&self, ids: &mut [NodeId], sort: SortSpec) {
        ids.sort_by(|left, right| {
            let left_node = &self.nodes[left.index()];
            let right_node = &self.nodes[right.index()];
            let ordering = match sort.by {
                SortBy::Name => natural_name_cmp(&left_node.name, &right_node.name),
                SortBy::LogicalBytes => left_node
                    .logical_bytes
                    .cmp(&right_node.logical_bytes)
                    .then_with(|| natural_name_cmp(&left_node.name, &right_node.name)),
                SortBy::AllocatedBytes => comparable_allocated(left_node)
                    .cmp(&comparable_allocated(right_node))
                    .then_with(|| left_node.logical_bytes.cmp(&right_node.logical_bytes))
                    .then_with(|| natural_name_cmp(&left_node.name, &right_node.name)),
                SortBy::Kind => kind_rank(left_node.kind)
                    .cmp(&kind_rank(right_node.kind))
                    .then_with(|| natural_name_cmp(&left_node.name, &right_node.name)),
            };

            match sort.direction {
                SortDirection::Asc => ordering,
                SortDirection::Desc => ordering.reverse(),
            }
        });
    }
}

#[derive(Default)]
struct ExtensionAccumulator {
    logical_bytes: u64,
    allocated_bytes: Option<u64>,
    file_count: u64,
}

enum Frame {
    Enter { path: PathBuf, id: NodeId },
    Exit { id: NodeId },
}

pub fn scan_path<P, F>(
    root: P,
    options: ScanOptions,
    cancel: Option<&AtomicBool>,
    mut emit: F,
) -> Result<ScanTree, ScanFailure>
where
    P: AsRef<Path>,
    F: FnMut(ScanEvent),
{
    let root_path = root.as_ref().to_path_buf();
    let metadata = metadata_for(&root_path, options.follow_symlinks).map_err(|source| {
        ScanFailure::Metadata {
            path: root_path.clone(),
            source,
        }
    })?;
    let root_kind = kind_for(&metadata);
    let root_device = device_id(&metadata);
    let mut nodes = Vec::new();
    let mut errors = Vec::new();
    let mut entries_scanned = 0_u64;
    let mut bytes_scanned = 0_u64;
    let mut cancelled = false;

    let root_id = push_node(
        &mut nodes,
        root_name(&root_path),
        None,
        root_kind,
        &metadata,
        &root_path,
        options.compute_allocated,
    );

    emit(ScanEvent::Started {
        root: root_path.clone(),
    });

    if root_kind == NodeKind::Directory {
        let mut stack = vec![Frame::Enter {
            path: root_path.clone(),
            id: root_id,
        }];

        while let Some(frame) = stack.pop() {
            if is_cancelled(cancel) {
                cancelled = true;
                break;
            }

            match frame {
                Frame::Enter { path, id } => {
                    stack.push(Frame::Exit { id });
                    let read_dir = match fs::read_dir(&path) {
                        Ok(read_dir) => read_dir,
                        Err(source) => {
                            record_error(&mut errors, &mut emit, path, source);
                            continue;
                        }
                    };

                    let mut child_dirs = Vec::new();
                    for entry_result in read_dir {
                        if is_cancelled(cancel) {
                            cancelled = true;
                            break;
                        }

                        let entry = match entry_result {
                            Ok(entry) => entry,
                            Err(source) => {
                                record_error(&mut errors, &mut emit, path.clone(), source);
                                continue;
                            }
                        };

                        let name = entry.file_name().to_string_lossy().to_string();
                        if !options.include_hidden && is_hidden(&name) {
                            continue;
                        }

                        let child_path = entry.path();
                        let child_metadata =
                            match metadata_for(&child_path, options.follow_symlinks) {
                                Ok(metadata) => metadata,
                                Err(source) => {
                                    record_error(&mut errors, &mut emit, child_path, source);
                                    continue;
                                }
                            };
                        let child_kind = kind_for(&child_metadata);

                        if options.stay_on_filesystem
                            && child_kind == NodeKind::Directory
                            && root_device.is_some()
                            && device_id(&child_metadata) != root_device
                        {
                            continue;
                        }

                        let child_id = push_node(
                            &mut nodes,
                            name,
                            Some(id),
                            child_kind,
                            &child_metadata,
                            &child_path,
                            options.compute_allocated,
                        );
                        nodes[id.index()].children.push(child_id);

                        if child_kind == NodeKind::Directory {
                            child_dirs.push((child_path.clone(), child_id));
                        }

                        entries_scanned += 1;
                        bytes_scanned =
                            bytes_scanned.saturating_add(nodes[child_id.index()].logical_bytes);
                        emit(ScanEvent::Progress {
                            entries_scanned,
                            bytes_scanned,
                            current_path: child_path,
                        });
                    }

                    for (child_path, child_id) in child_dirs.into_iter().rev() {
                        stack.push(Frame::Enter {
                            path: child_path,
                            id: child_id,
                        });
                    }
                }
                Frame::Exit { id } => aggregate_directory(&mut nodes, id),
            }
        }
    }

    if cancelled {
        aggregate_all_directories(&mut nodes);
    }

    let tree = ScanTree {
        root: root_id,
        root_path,
        nodes,
        errors,
        cancelled,
    };
    let summary = tree.summary();
    if cancelled {
        emit(ScanEvent::Cancelled { summary });
    } else {
        emit(ScanEvent::Completed { summary });
    }

    Ok(tree)
}

fn metadata_for(path: &Path, follow_symlinks: bool) -> std::io::Result<fs::Metadata> {
    if follow_symlinks {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    }
}

fn push_node(
    nodes: &mut Vec<Node>,
    name: String,
    parent: Option<NodeId>,
    kind: NodeKind,
    metadata: &fs::Metadata,
    path: &Path,
    compute_allocated: bool,
) -> NodeId {
    let id = NodeId(nodes.len() as u32);
    let own_logical_bytes = if kind == NodeKind::File {
        metadata.len()
    } else {
        0
    };
    let own_allocated_bytes = if compute_allocated && kind != NodeKind::Symlink {
        allocated_size(metadata, path)
    } else {
        None
    };

    nodes.push(Node {
        id,
        name,
        parent,
        kind,
        children: Vec::new(),
        own_logical_bytes,
        own_allocated_bytes,
        logical_bytes: own_logical_bytes,
        allocated_bytes: own_allocated_bytes,
        file_count: u64::from(kind == NodeKind::File),
        directory_count: u64::from(kind == NodeKind::Directory),
        symlink_count: u64::from(kind == NodeKind::Symlink),
    });
    id
}

fn aggregate_directory(nodes: &mut [Node], id: NodeId) {
    let index = id.index();
    if nodes[index].kind != NodeKind::Directory {
        return;
    }

    let mut logical_bytes = nodes[index].own_logical_bytes;
    let mut allocated_bytes = nodes[index].own_allocated_bytes;
    let mut file_count = 0_u64;
    let mut directory_count = 1_u64;
    let mut symlink_count = 0_u64;
    let child_ids = nodes[index].children.clone();

    for child_id in child_ids {
        let child = &nodes[child_id.index()];
        logical_bytes = logical_bytes.saturating_add(child.logical_bytes);
        allocated_bytes = merge_allocated(allocated_bytes, child.allocated_bytes);
        file_count = file_count.saturating_add(child.file_count);
        directory_count = directory_count.saturating_add(child.directory_count);
        symlink_count = symlink_count.saturating_add(child.symlink_count);
    }

    nodes[index].logical_bytes = logical_bytes;
    nodes[index].allocated_bytes = allocated_bytes;
    nodes[index].file_count = file_count;
    nodes[index].directory_count = directory_count;
    nodes[index].symlink_count = symlink_count;
}

fn aggregate_all_directories(nodes: &mut [Node]) {
    for index in (0..nodes.len()).rev() {
        let id = nodes[index].id;
        aggregate_directory(nodes, id);
    }
}

fn merge_allocated(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.saturating_add(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn record_error<F>(errors: &mut Vec<ScanError>, emit: &mut F, path: PathBuf, source: std::io::Error)
where
    F: FnMut(ScanEvent),
{
    let message = source.to_string();
    errors.push(ScanError {
        path: path.clone(),
        message: message.clone(),
    });
    emit(ScanEvent::Error { path, message });
}

fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|cancel| cancel.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn root_name(path: &Path) -> String {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.display().to_string())
}

fn kind_for(metadata: &fs::Metadata) -> NodeKind {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        NodeKind::Symlink
    } else if file_type.is_dir() {
        NodeKind::Directory
    } else if file_type.is_file() {
        NodeKind::File
    } else {
        NodeKind::Other
    }
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn comparable_allocated(node: &Node) -> u64 {
    node.allocated_bytes.unwrap_or(node.logical_bytes)
}

fn natural_name_cmp(left: &str, right: &str) -> CmpOrdering {
    left.to_ascii_lowercase()
        .cmp(&right.to_ascii_lowercase())
        .then_with(|| left.cmp(right))
}

fn kind_rank(kind: NodeKind) -> u8 {
    match kind {
        NodeKind::Directory => 0,
        NodeKind::File => 1,
        NodeKind::Symlink => 2,
        NodeKind::Other => 3,
    }
}

#[cfg(unix)]
fn device_id(metadata: &fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;

    Some(metadata.dev())
}

#[cfg(not(unix))]
fn device_id(_metadata: &fs::Metadata) -> Option<u64> {
    None
}

#[cfg(unix)]
fn allocated_size(metadata: &fs::Metadata, _path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;

    Some(metadata.blocks().saturating_mul(512))
}

#[cfg(windows)]
fn allocated_size(_metadata: &fs::Metadata, path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, NO_ERROR};
    use windows::Win32::Storage::FileSystem::GetCompressedFileSizeW;

    let mut path_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut high = 0_u32;
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(path_wide.as_mut_ptr()), Some(&mut high)) };
    if low == u32::MAX {
        let error = unsafe { GetLastError() };
        if error != NO_ERROR {
            return None;
        }
    }
    Some(((high as u64) << 32) | low as u64)
}

#[cfg(not(any(unix, windows)))]
fn allocated_size(_metadata: &fs::Metadata, _path: &Path) -> Option<u64> {
    None
}
