use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use super::session::SshSession;

pub type SharedSshSession = Arc<Mutex<SshSession>>;

#[derive(Default)]
pub struct ConnectionPool {
    sessions: RwLock<HashMap<Uuid, SharedSshSession>>,
}

impl ConnectionPool {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub async fn add(&self, session: SshSession) -> Uuid {
        let id = Uuid::new_v4();
        self.sessions
            .write()
            .await
            .insert(id, Arc::new(Mutex::new(session)));
        id
    }

    pub async fn get(&self, id: &Uuid) -> Option<SharedSshSession> {
        self.sessions.read().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &Uuid) -> Option<SharedSshSession> {
        self.sessions.write().await.remove(id)
    }

    pub async fn list_active(&self) -> Vec<Uuid> {
        self.sessions.read().await.keys().copied().collect()
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

pub struct SshPool(pub ConnectionPool);
