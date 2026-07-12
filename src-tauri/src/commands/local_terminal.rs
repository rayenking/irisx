use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{State, ipc::Channel};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;

const READ_BATCH_LIMIT: usize = 8 * 1024;
const READ_CHANNEL_CAPACITY: usize = 128;
const MAX_WRITE_BYTES: usize = 64 * 1024;

#[cfg(unix)]
fn signal_pid(pid: libc::pid_t, signal: libc::c_int) {
    unsafe {
        let _ = libc::kill(pid, signal);
    }
}

/// Collect the full descendant tree under `root_pid` (including root).
/// npm/vite/python often leave the shell process group, so group kill alone
/// leaves them orphaned and holding ports.
#[cfg(target_os = "linux")]
fn collect_process_tree(root_pid: u32) -> Vec<u32> {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::fs;

    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();

    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };

            let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(value) => value,
                Err(_) => continue,
            };

            // comm can contain spaces/parens — ppid is the 4th field after the closing ')'.
            let Some(after_comm) = stat.rsplit(')').next() else {
                continue;
            };
            let fields: Vec<&str> = after_comm.split_whitespace().collect();
            // fields[0]=state, fields[1]=ppid
            if let Some(ppid) = fields.get(1).and_then(|value| value.parse::<u32>().ok()) {
                children_of.entry(ppid).or_default().push(pid);
            }
        }
    }

    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root_pid]);

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        ordered.push(pid);
        if let Some(children) = children_of.get(&pid) {
            queue.extend(children.iter().copied());
        }
    }

    ordered
}

#[cfg(target_os = "macos")]
fn collect_process_tree(root_pid: u32) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};
    use std::process::Command;

    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root_pid]);

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        ordered.push(pid);

        let Ok(output) = Command::new("pgrep").args(["-P", &pid.to_string()]).output() else {
            continue;
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(child) = line.trim().parse::<u32>() {
                queue.push_back(child);
            }
        }
    }

    ordered
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn collect_process_tree(root_pid: u32) -> Vec<u32> {
    vec![root_pid]
}

#[cfg(unix)]
fn signal_process_tree(root_pid: u32, signal: libc::c_int) {
    // Children first so parents don't reap and hide them mid-walk.
    let mut tree = collect_process_tree(root_pid);
    tree.reverse();
    for pid in tree {
        signal_pid(pid as libc::pid_t, signal);
    }
}

#[cfg(unix)]
fn terminate_shell_tree(process_group_leader: Option<libc::pid_t>, child_pid: Option<u32>) {
    if let Some(leader) = process_group_leader {
        let process_group_id = -leader;
        // SIGHUP first so interactive shells drop job-control children.
        signal_pid(process_group_id, libc::SIGHUP);
        signal_pid(process_group_id, libc::SIGTERM);
    }

    if let Some(pid) = child_pid {
        signal_process_tree(pid, libc::SIGTERM);
    }

    // Child servers often ignore HUP/TERM. Hard-kill after a short grace period.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));

        if let Some(leader) = process_group_leader {
            signal_pid(-leader, libc::SIGKILL);
        }

        if let Some(pid) = child_pid {
            signal_process_tree(pid, libc::SIGKILL);
        }
    });
}

type SharedLocalShellSession = Arc<Mutex<LocalShellSession>>;

fn spawn_reader_task(
    mut reader: Box<dyn Read + Send>,
    output_tx: mpsc::Sender<Vec<u8>>,
) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0_u8; 4096];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read_count) => {
                    if output_tx.blocking_send(buffer[..read_count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_stream_task(
    mut output_rx: mpsc::Receiver<Vec<u8>>,
    on_data: Channel<Vec<u8>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(READ_BATCH_LIMIT);
        let flush_interval = Duration::from_millis(8);

        loop {
            if buffer.is_empty() {
                match output_rx.recv().await {
                    Some(chunk) => buffer.extend_from_slice(&chunk),
                    None => break,
                }
            } else {
                match tokio::time::timeout(flush_interval, output_rx.recv()).await {
                    Ok(Some(chunk)) => buffer.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(_) => {
                        if on_data.send(std::mem::take(&mut buffer)).is_err() {
                            break;
                        }
                        continue;
                    }
                }
            }

            if buffer.len() >= READ_BATCH_LIMIT && on_data.send(std::mem::take(&mut buffer)).is_err() {
                break;
            }
        }

        if !buffer.is_empty() {
            let _ = on_data.send(buffer);
        }

        let _ = on_data.send(Vec::new());
    })
}

pub struct LocalShellSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    child_pid: Option<u32>,
    reader_task: Option<JoinHandle<()>>,
    stream_task: Option<JoinHandle<()>>,
    exit_task: Option<JoinHandle<()>>,
}

impl LocalShellSession {
    fn new(
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
        child_pid: Option<u32>,
        reader_task: JoinHandle<()>,
        stream_task: JoinHandle<()>,
        exit_task: JoinHandle<()>,
    ) -> Self {
        Self {
            master: Arc::new(Mutex::new(master)),
            writer: Arc::new(Mutex::new(writer)),
            child,
            child_pid,
            reader_task: Some(reader_task),
            stream_task: Some(stream_task),
            exit_task: Some(exit_task),
        }
    }

    fn get_cwd(&self) -> Option<String> {
        let pid = self.child_pid?;

        #[cfg(target_os = "linux")]
        {
            let link = format!("/proc/{pid}/cwd");
            std::fs::read_link(&link).ok().map(|p| p.to_string_lossy().into_owned())
        }

        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("lsof")
                .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout
                .lines()
                .find(|line| line.starts_with('n'))
                .map(|line| line[1..].to_string())
        }

        #[cfg(not(unix))]
        {
            let _ = pid;
            None
        }
    }

    async fn write(&self, data: &[u8]) -> Result<()> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(anyhow::anyhow!("local shell write exceeds {} bytes", MAX_WRITE_BYTES));
        }

        let mut writer = self.writer.lock().await;
        writer
            .write_all(data)
            .context("failed to write data to local shell")?;
        writer.flush().context("failed to flush local shell writer")?;
        Ok(())
    }

    async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.master
            .lock()
            .await
            .resize(pty_size(cols, rows))
            .context("failed to resize local PTY")?;
        Ok(())
    }

    fn detach_reading(&mut self) {
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }

        if let Some(task) = self.stream_task.take() {
            task.abort();
        }
    }

    fn attach_reading(&mut self, on_data: Channel<Vec<u8>>) -> Result<()> {
        self.detach_reading();

        let reader = self
            .master
            .blocking_lock()
            .try_clone_reader()
            .context("failed to clone PTY reader for local shell attach")?;
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(READ_CHANNEL_CAPACITY);

        self.reader_task = Some(spawn_reader_task(reader, output_tx));
        self.stream_task = Some(spawn_stream_task(output_rx, on_data));
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        self.detach_reading();

        if let Some(task) = self.exit_task.take() {
            task.abort();
        }

        #[cfg(unix)]
        {
            let process_group_leader = self.master.lock().await.process_group_leader();
            terminate_shell_tree(process_group_leader, self.child_pid);
        }

        if let Err(error) = self.child.lock().await.kill() {
            log::debug!("local shell kill during disconnect returned: {error}");
        }

        Ok(())
    }

}

impl Drop for LocalShellSession {
    fn drop(&mut self) {
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }

        if let Some(task) = self.stream_task.take() {
            task.abort();
        }

        if let Some(task) = self.exit_task.take() {
            task.abort();
        }

        #[cfg(unix)]
        {
            let process_group_leader = self
                .master
                .try_lock()
                .ok()
                .and_then(|master| master.process_group_leader());
            terminate_shell_tree(process_group_leader, self.child_pid);
        }

        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub struct LocalShellPool {
    sessions: Arc<RwLock<HashMap<Uuid, SharedLocalShellSession>>>,
}

impl LocalShellPool {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn add(&self, id: Uuid, session: LocalShellSession) {
        self.sessions
            .write()
            .await
            .insert(id, Arc::new(Mutex::new(session)));
    }

    pub async fn get(&self, id: &Uuid) -> Option<SharedLocalShellSession> {
        self.sessions.read().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &Uuid) -> Option<SharedLocalShellSession> {
        self.sessions.write().await.remove(id)
    }

    pub async fn disconnect_all(&self) {
        let sessions: Vec<_> = {
            let mut guard = self.sessions.write().await;
            guard.drain().map(|(_, session)| session).collect()
        };

        for session in sessions {
            let _ = session.lock().await.disconnect().await;
        }
    }
}

#[tauri::command]
pub async fn local_shell_open(
    pool: State<'_, LocalShellPool>,
    on_data: Channel<Vec<u8>>,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(default_shell());
    command.arg("-l");
    command.env("TERM", "xterm-256color");
    if let Ok(lang) = env::var("LANG") {
        command.env("LANG", lang);
    }
    if let Some(ref dir) = cwd {
        let path = std::path::Path::new(dir);
        if path.is_dir() {
            command.cwd(path);
        }
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;

    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(READ_CHANNEL_CAPACITY);
    let reader_task = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 4096];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read_count) => {
                    if output_tx.blocking_send(buffer[..read_count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let stream_task = tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(READ_BATCH_LIMIT);
        let flush_interval = Duration::from_millis(8);

        loop {
            if buffer.is_empty() {
                match output_rx.recv().await {
                    Some(chunk) => buffer.extend_from_slice(&chunk),
                    None => break,
                }
            } else {
                match tokio::time::timeout(flush_interval, output_rx.recv()).await {
                    Ok(Some(chunk)) => buffer.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(_) => {
                        if on_data.send(std::mem::take(&mut buffer)).is_err() {
                            break;
                        }
                        continue;
                    }
                }
            }

            if buffer.len() >= READ_BATCH_LIMIT && on_data.send(std::mem::take(&mut buffer)).is_err() {
                break;
            }
        }

        if !buffer.is_empty() {
            let _ = on_data.send(buffer);
        }

        let _ = on_data.send(Vec::new());
    });

    let child_pid = child.process_id();
    let child = Arc::new(Mutex::new(child));
    let session_id = Uuid::new_v4();
    let sessions = Arc::clone(&pool.sessions);
    let exit_child = Arc::clone(&child);
    let exit_task = tokio::task::spawn_blocking(move || {
        let _ = exit_child.blocking_lock().wait();
        sessions.blocking_write().remove(&session_id);
    });

    let session = LocalShellSession::new(pair.master, writer, child, child_pid, reader_task, stream_task, exit_task);
    pool.add(session_id, session).await;

    Ok(session_id.to_string())
}

#[tauri::command]
pub async fn local_shell_attach(
    pool: State<'_, LocalShellPool>,
    session_id: String,
    on_data: Channel<Vec<u8>>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let session = get_session(&pool, &session_id).await?;
    let session = session.lock().await;
    session.resize(cols, rows).await.map_err(|error| error.to_string())?;
    drop(session);

    let current_session = get_session(&pool, &session_id).await?;
    let mut current_session = current_session.lock().await;
    current_session.detach_reading();
    current_session
        .attach_reading(on_data)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn local_shell_write(
    pool: State<'_, LocalShellPool>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = get_session(&pool, &session_id).await?;
    let result = session
        .lock()
        .await
        .write(&data)
        .await
        .map_err(|error| error.to_string());

    result
}

#[tauri::command]
pub async fn local_shell_resize(
    pool: State<'_, LocalShellPool>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let session = get_session(&pool, &session_id).await?;
    let result = session
        .lock()
        .await
        .resize(cols, rows)
        .await
        .map_err(|error| error.to_string());

    result
}

#[tauri::command]
pub async fn local_shell_cwd(
    pool: State<'_, LocalShellPool>,
    session_id: String,
) -> Result<String, String> {
    let session = get_session(&pool, &session_id).await?;
    let cwd = session
        .lock()
        .await
        .get_cwd()
        .unwrap_or_default();
    Ok(cwd)
}

#[tauri::command]
pub async fn local_shell_disconnect(
    pool: State<'_, LocalShellPool>,
    session_id: String,
) -> Result<(), String> {
    let session_id = parse_session_id(&session_id)?;
    let session = pool
        .remove(&session_id)
        .await
        .ok_or_else(|| format!("local shell session not found: {session_id}"))?;

    let result = session
        .lock()
        .await
        .disconnect()
        .await
        .map_err(|error| error.to_string());

    result
}

async fn get_session(
    pool: &State<'_, LocalShellPool>,
    session_id: &str,
) -> Result<SharedLocalShellSession, String> {
    let session_id = parse_session_id(session_id)?;
    pool.get(&session_id)
        .await
        .ok_or_else(|| format!("local shell session not found: {session_id}"))
}

fn parse_session_id(session_id: &str) -> Result<Uuid, String> {
    Uuid::parse_str(session_id).map_err(|error| error.to_string())
}

fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        rows: rows.clamp(1, u16::MAX as u32) as u16,
        cols: cols.clamp(1, u16::MAX as u32) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn default_shell() -> String {
    env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "cmd.exe".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
}
