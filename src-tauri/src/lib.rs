use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent};

pub mod commands;
pub mod config;
pub mod db;
pub mod keychain;
pub mod ssh;

static EXIT_CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

async fn cleanup_sessions(app: &tauri::AppHandle) {
    if let Some(local_pool) = app.try_state::<commands::local_terminal::LocalShellPool>() {
        local_pool.disconnect_all().await;
    }

    if let Some(ssh_pool) = app.try_state::<ssh::pool::SshPool>() {
        ssh_pool.0.disconnect_all().await;
    }

    // Wait for the deferred SIGKILL pass in terminate_shell_tree.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let db_connection = db::init_db(&app_data_dir).map_err(|error| error.to_string())?;

            if let Err(e) = keychain::init_keychain(&app_data_dir) {
                log::warn!("Keychain unavailable, credential storage will not work: {e}");
            }

            app.manage(db::DbState(std::sync::Mutex::new(db_connection)));
            app.manage(ssh::pool::SshPool(ssh::ConnectionPool::new()));
            app.manage(commands::local_terminal::LocalShellPool::new());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_connections,
            commands::connection::get_connection,
            commands::connection::create_connection,
            commands::connection::update_connection,
            commands::connection::delete_connection,
            commands::connection::duplicate_connection,
            commands::connection::search_connections,
            commands::connection::list_groups,
            commands::connection::create_group,
            commands::connection::update_group,
            commands::connection::delete_group,
            commands::terminal::ssh_connect,
            commands::terminal::ssh_attach,
            commands::terminal::ssh_disconnect,
            commands::terminal::ssh_write,
            commands::terminal::ssh_resize,
            commands::terminal::ssh_test_connection,
            commands::local_terminal::local_shell_open,
            commands::local_terminal::local_shell_attach,
            commands::local_terminal::local_shell_write,
            commands::local_terminal::local_shell_resize,
            commands::local_terminal::local_shell_disconnect,
            commands::local_terminal::local_shell_cwd,
            commands::tunnel::create_tunnel,
            commands::tunnel::stop_tunnel,
            commands::tunnel::list_tunnels,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_realpath,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_remote_transfer,
            commands::sftp::local_list_dir,
            commands::sftp::local_read_file,
            commands::sftp::local_write_file,
            commands::sftp::local_delete,
            commands::sftp::local_rename,
            commands::sftp::local_copy_file,
            commands::sftp::local_mkdir,
            commands::sftp::reveal_in_file_manager,
            commands::config::parse_ssh_config,
            commands::config::import_ssh_config,
            commands::git::get_git_repo_root,
            commands::git::get_git_status,
            commands::git::get_git_diff,
            commands::keychain::store_credential,
            commands::keychain::retrieve_credential,
            commands::keychain::delete_credential,
            commands::keychain::has_credential,
            commands::snippets::list_snippets,
            commands::snippets::create_snippet,
            commands::snippets::update_snippet,
            commands::snippets::delete_snippet,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_all_settings,
            commands::tunnel::remove_tunnel,
            commands::updater::check_for_updates,
            commands::updater::get_current_version,
            commands::updater::download_update,
            commands::updater::install_update,
            commands::backup::export_data,
            commands::backup::preview_import,
            commands::backup::import_data
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Finish killing shells before the process dies, otherwise the deferred
            // SIGKILL threads never run and child servers keep ports open.
            if let RunEvent::ExitRequested { api, .. } = &event {
                if EXIT_CLEANUP_DONE.swap(true, Ordering::SeqCst) {
                    return;
                }

                api.prevent_exit();
                let handle = app.clone();
                tauri::async_runtime::block_on(async move {
                    cleanup_sessions(&handle).await;
                });
                app.exit(0);
            }
        });
}
