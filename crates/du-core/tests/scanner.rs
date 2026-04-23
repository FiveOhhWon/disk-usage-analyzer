use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use du_core::{
    scan_path, NodeKind, ScanEvent, ScanOptions, SortBy, SortDirection, SortSpec, TopKind,
};
use tempfile::TempDir;

fn write_file(path: &Path, bytes: usize) {
    fs::write(path, vec![b'x'; bytes]).unwrap();
}

#[test]
fn aggregates_directory_sizes_and_counts() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("src")).unwrap();
    write_file(&temp.path().join("src/lib.rs"), 13);
    write_file(&temp.path().join("src/main.rs"), 21);
    write_file(&temp.path().join("README.md"), 8);

    let tree = scan_path(temp.path(), ScanOptions::default(), None, |_| {}).unwrap();
    let summary = tree.summary();

    assert_eq!(summary.total_logical_bytes, 42);
    assert_eq!(summary.file_count, 3);
    assert_eq!(summary.directory_count, 2);

    let root_children = tree
        .children(
            tree.root_id(),
            SortSpec {
                by: SortBy::Name,
                direction: SortDirection::Asc,
            },
            0,
            10,
        )
        .unwrap();

    assert_eq!(root_children.total, 2);
    assert_eq!(root_children.items[0].name, "README.md");
    assert_eq!(root_children.items[1].name, "src");
    assert_eq!(root_children.items[1].logical_bytes, 34);
}

#[test]
fn reconstructs_paths_from_names_and_parents() {
    let temp = TempDir::new().unwrap();
    fs::create_dir_all(temp.path().join("a/b")).unwrap();
    write_file(&temp.path().join("a/b/file.txt"), 5);

    let tree = scan_path(temp.path(), ScanOptions::default(), None, |_| {}).unwrap();
    let top_file = tree.top_items(TopKind::Files, 1).unwrap().remove(0);

    assert_eq!(top_file.name, "file.txt");
    assert_eq!(
        tree.path_for(top_file.id).unwrap(),
        temp.path().join("a/b/file.txt")
    );
}

#[test]
fn supports_sorting_and_pagination_without_returning_all_children() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join("small.log"), 3);
    write_file(&temp.path().join("large.log"), 30);
    write_file(&temp.path().join("medium.log"), 12);

    let tree = scan_path(temp.path(), ScanOptions::default(), None, |_| {}).unwrap();
    let page = tree
        .children(
            tree.root_id(),
            SortSpec {
                by: SortBy::LogicalBytes,
                direction: SortDirection::Desc,
            },
            1,
            1,
        )
        .unwrap();

    assert_eq!(page.total, 3);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].name, "medium.log");
}

#[test]
fn reports_extension_breakdown_and_top_items() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join("a.log"), 10);
    write_file(&temp.path().join("b.log"), 5);
    write_file(&temp.path().join("image.png"), 3);
    write_file(&temp.path().join("LICENSE"), 2);

    let tree = scan_path(temp.path(), ScanOptions::default(), None, |_| {}).unwrap();
    let extensions = tree.extension_breakdown(10);
    let top_files = tree.top_items(TopKind::Files, 2).unwrap();

    assert_eq!(extensions[0].extension, "log");
    assert_eq!(extensions[0].logical_bytes, 15);
    assert_eq!(extensions[0].file_count, 2);
    assert_eq!(top_files[0].name, "a.log");
    assert_eq!(top_files[1].name, "b.log");
}

#[test]
fn skips_hidden_entries_when_configured() {
    let temp = TempDir::new().unwrap();
    write_file(&temp.path().join(".secret"), 100);
    write_file(&temp.path().join("visible"), 7);

    let tree = scan_path(
        temp.path(),
        ScanOptions {
            include_hidden: false,
            ..ScanOptions::default()
        },
        None,
        |_| {},
    )
    .unwrap();

    assert_eq!(tree.summary().total_logical_bytes, 7);
    assert_eq!(
        tree.top_items(TopKind::Files, 10).unwrap()[0].name,
        "visible"
    );
}

#[test]
fn does_not_follow_symlinked_directories_by_default() {
    let temp = TempDir::new().unwrap();
    fs::create_dir(temp.path().join("target")).unwrap();
    write_file(&temp.path().join("target/nested.bin"), 50);

    #[cfg(unix)]
    std::os::unix::fs::symlink(temp.path().join("target"), temp.path().join("link")).unwrap();

    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(temp.path().join("target"), temp.path().join("link"))
        .unwrap();

    let tree = scan_path(temp.path(), ScanOptions::default(), None, |_| {}).unwrap();
    let children = tree
        .children(tree.root_id(), SortSpec::default(), 0, 10)
        .unwrap()
        .items;
    let link = children.iter().find(|row| row.name == "link").unwrap();

    assert_eq!(link.kind, NodeKind::Symlink);
    assert_eq!(tree.summary().total_logical_bytes, 50);
}

#[test]
fn cancellation_returns_partial_tree_and_cancelled_event() {
    let temp = TempDir::new().unwrap();
    for index in 0..25 {
        write_file(&temp.path().join(format!("file-{index}.bin")), 1);
    }

    let cancel = AtomicBool::new(false);
    let mut saw_cancelled = false;
    let tree = scan_path(
        temp.path(),
        ScanOptions::default(),
        Some(&cancel),
        |event| {
            if matches!(event, ScanEvent::Progress { entries_scanned, .. } if entries_scanned >= 3)
            {
                cancel.store(true, Ordering::Relaxed);
            }
            if matches!(event, ScanEvent::Cancelled { .. }) {
                saw_cancelled = true;
            }
        },
    )
    .unwrap();

    assert!(tree.summary().cancelled);
    assert!(saw_cancelled);
    assert!(tree.summary().file_count < 25);
}
