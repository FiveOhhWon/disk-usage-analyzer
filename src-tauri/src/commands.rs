use std::path::PathBuf;

use du_core::{NodeId, ScanEvent, ScanOptions, SortSpec, TopKind, VolumeInfo};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::{self, AppError, AppState, ScanHandle, ScanInfo};

#[tauri::command]
pub fn list_volumes() -> Vec<VolumeInfo> {
    state::list_volumes()
}

#[tauri::command(rename_all = "snake_case")]
pub fn start_scan(
    root: String,
    options: ScanOptions,
    progress_channel: Channel<ScanEvent>,
    state: State<'_, AppState>,
) -> Result<ScanHandle, AppError> {
    let notifier = Box::new(move |event| {
        let _ = progress_channel.send(event);
    });
    state.start_scan(PathBuf::from(root), options, Some(notifier))
}

#[tauri::command(rename_all = "snake_case")]
pub fn cancel_scan(scan_id: String, state: State<'_, AppState>) -> Result<ScanInfo, AppError> {
    state.cancel_scan(&scan_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_scan_summary(scan_id: String, state: State<'_, AppState>) -> Result<ScanInfo, AppError> {
    state.get_scan_summary(&scan_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_children(
    scan_id: String,
    node_id: Option<NodeId>,
    sort: SortSpec,
    offset: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<du_core::Page<du_core::NodeRow>, AppError> {
    state.get_children(&scan_id, node_id, sort, offset, limit)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_top_items(
    scan_id: String,
    kind: TopKind,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<du_core::NodeRow>, AppError> {
    state.get_top_items(&scan_id, kind, limit)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_extension_breakdown(
    scan_id: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<du_core::ExtensionRow>, AppError> {
    state.get_extension_breakdown(&scan_id, limit)
}

#[tauri::command(rename_all = "snake_case")]
pub fn reveal_item(
    scan_id: String,
    node_id: NodeId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let path = state.path_for_node(&scan_id, node_id)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| AppError::Io {
            message: error.to_string(),
        })
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_item(
    scan_id: String,
    node_id: NodeId,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let path = state.path_for_node(&scan_id, node_id)?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| AppError::Io {
            message: error.to_string(),
        })
}

#[tauri::command(rename_all = "snake_case")]
pub fn trash_item(
    scan_id: String,
    node_id: NodeId,
    state: State<'_, AppState>,
) -> Result<ScanInfo, AppError> {
    state.trash_item(&scan_id, node_id)
}
