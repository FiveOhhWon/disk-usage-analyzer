pub mod commands;
pub mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_volumes,
            commands::start_scan,
            commands::cancel_scan,
            commands::get_scan_summary,
            commands::get_children,
            commands::get_top_items,
            commands::get_extension_breakdown,
            commands::reveal_item,
            commands::open_item,
            commands::trash_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
