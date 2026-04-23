use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use disk_usage_lib::state::{AppError, AppState, ScanStatus};
use du_core::{ScanOptions, SortBy, SortDirection, SortSpec, TopKind};
use tempfile::TempDir;

fn write_file(path: &Path, bytes: usize) {
    fs::write(path, vec![b'x'; bytes]).unwrap();
}

#[test]
fn session_completes_and_serves_lazy_children() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("cache")).unwrap();
    write_file(&temp.path().join("cache/blob.bin"), 40);
    write_file(&temp.path().join("notes.txt"), 10);

    let state = AppState::default();
    let handle = state
        .start_scan(temp.path().to_path_buf(), ScanOptions::default(), None)
        .unwrap();

    let info = state
        .wait_for_scan_for_test(&handle.scan_id, Duration::from_secs(2))
        .unwrap();
    assert_eq!(info.status, ScanStatus::Complete);
    assert_eq!(info.summary.unwrap().total_logical_bytes, 50);

    let children = state
        .get_children(
            &handle.scan_id,
            None,
            SortSpec {
                by: SortBy::LogicalBytes,
                direction: SortDirection::Desc,
            },
            0,
            1,
        )
        .unwrap();

    assert_eq!(children.total, 2);
    assert_eq!(children.items[0].name, "cache");
    assert_eq!(children.items[0].logical_bytes, 40);
}

#[test]
fn top_items_and_extension_breakdown_are_session_scoped() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join("a.log"), 10);
    write_file(&temp.path().join("b.log"), 15);
    write_file(&temp.path().join("image.png"), 4);

    let state = AppState::default();
    let handle = state
        .start_scan(temp.path().to_path_buf(), ScanOptions::default(), None)
        .unwrap();
    state
        .wait_for_scan_for_test(&handle.scan_id, Duration::from_secs(2))
        .unwrap();

    let top_files = state
        .get_top_items(&handle.scan_id, TopKind::Files, 2)
        .unwrap();
    let extensions = state.get_extension_breakdown(&handle.scan_id, 2).unwrap();

    assert_eq!(top_files[0].name, "b.log");
    assert_eq!(extensions[0].extension, "log");
    assert_eq!(extensions[0].logical_bytes, 25);
}

#[test]
fn invalid_node_id_returns_structured_error() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join("a.txt"), 1);

    let state = AppState::default();
    let handle = state
        .start_scan(temp.path().to_path_buf(), ScanOptions::default(), None)
        .unwrap();
    state
        .wait_for_scan_for_test(&handle.scan_id, Duration::from_secs(2))
        .unwrap();

    let error = state
        .get_children(
            &handle.scan_id,
            Some(du_core::NodeId(99_999)),
            SortSpec::default(),
            0,
            10,
        )
        .unwrap_err();

    assert!(matches!(error, AppError::InvalidNode { .. }));
}

#[test]
fn trash_rejects_root_and_marks_completed_scan_stale_after_delete() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join("delete-me.tmp"), 5);

    let state = AppState::default();
    let handle = state
        .start_scan(temp.path().to_path_buf(), ScanOptions::default(), None)
        .unwrap();
    state
        .wait_for_scan_for_test(&handle.scan_id, Duration::from_secs(2))
        .unwrap();

    let root_error = state
        .trash_item_with(&handle.scan_id, du_core::NodeId(0), |_| Ok(()))
        .unwrap_err();
    assert!(matches!(root_error, AppError::UnsafePath { .. }));

    let file = state
        .get_top_items(&handle.scan_id, TopKind::Files, 1)
        .unwrap()
        .remove(0);
    let expected_deleted_path = temp.path().join("delete-me.tmp").canonicalize().unwrap();
    let deleted_path = Arc::new(Mutex::new(None));
    let deleted_path_for_closure = Arc::clone(&deleted_path);

    let info = state
        .trash_item_with(&handle.scan_id, file.id, move |path: &Path| {
            *deleted_path_for_closure.lock().unwrap() = Some(path.to_path_buf());
            fs::remove_file(path).map_err(AppError::from)
        })
        .unwrap();

    assert!(info.stale);
    assert_eq!(
        deleted_path.lock().unwrap().as_ref().unwrap(),
        &expected_deleted_path
    );
}
