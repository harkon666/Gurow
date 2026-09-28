use crate::geometry::{Point, Rect, Size};
use serde::{Deserialize, Serialize};

pub const DEFAULT_CARD_WIDTH: f32 = 180.0;
pub const DEFAULT_CARD_HEIGHT: f32 = 80.0;

/// Returns the default world-space size used for a Skill card when a snapshot
/// omits its size.
pub fn default_card_size() -> Size {
    Size::new(DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// A positioned Skill in the editable Canvas Document.
///
/// The `id` is the stable identity shared with the application learning
/// payload. `position` and `size` are world-space values owned by the editor.
pub struct SkillCard {
    pub id: String,
    pub title: String,
    pub position: Point,
    #[serde(default = "default_card_size")]
    pub size: Size,
}


impl SkillCard {
    /// Creates a card, applying the standard size when `size` is `None`.
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        position: Point,
        size: Option<Size>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            position,
            size: size.unwrap_or(Size::new(DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT)),
        }
    }

    pub fn world_bounds(&self) -> Rect {
        Rect::new(self.position.x, self.position.y, self.size.width, self.size.height)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
/// A directed Prerequisite edge from `from_id` to `to_id`.
pub struct PrerequisiteConnection {
    pub from_id: String,
    pub to_id: String,
}

impl PrerequisiteConnection {
    /// Creates an edge without validating whether its endpoints exist.
    ///
    /// Use [`CanvasDocument::try_add_connection`] when adding an edge to a
    /// document so duplicate and cycle invariants are checked.
    pub fn new(from_id: impl Into<String>, to_id: impl Into<String>) -> Self {
        Self {
            from_id: from_id.into(),
            to_id: to_id.into(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
/// The editor-owned cards and directed Prerequisite Graph.
///
/// The document is serializable as the editor portion of a checkpoint. Task
/// content and other learning-domain data remain in the application payload.
pub struct CanvasDocument {
    pub cards: Vec<SkillCard>,
    #[serde(default)]
    pub connections: Vec<PrerequisiteConnection>,
}

impl CanvasDocument {
    /// Creates an empty document with no cards or connections.
    pub fn new() -> Self {
        Self {
            cards: Vec::new(),
            connections: Vec::new(),
        }
    }

    pub fn add_card(&mut self, card: SkillCard) -> Result<(), String> {
        if self.cards.iter().any(|c| c.id == card.id) {
            return Err(format!("Card with id '{}' already exists", card.id));
        }
        self.cards.push(card);
        Ok(())
    }

    /// Finds a card by its stable Skill ID.
    pub fn find_card(&self, id: &str) -> Option<&SkillCard> {
        self.cards.iter().find(|c| c.id == id)
    }

    /// Reports whether the exact directed edge already exists.
    pub fn has_connection(&self, from_id: &str, to_id: &str) -> bool {
        self.connections
            .iter()
            .any(|c| c.from_id == from_id && c.to_id == to_id)
    }

    /// Inserts an edge if the exact edge is not already present.
    ///
    /// This low-level method assumes validation has already happened; callers
    /// accepting user input should prefer [`Self::try_add_connection`].
    pub fn add_connection(&mut self, connection: PrerequisiteConnection) {
        if !self.has_connection(&connection.from_id, &connection.to_id) {
            self.connections.push(connection);
        }
    }

    /// Removes an exact edge and reports whether anything changed.
    pub fn remove_connection(&mut self, from_id: &str, to_id: &str) -> bool {
        let initial_len = self.connections.len();
        self.connections
            .retain(|c| !(c.from_id == from_id && c.to_id == to_id));
        self.connections.len() < initial_len
    }

    /// Returns one directed path from `start` to `target`, if one exists.
    ///
    /// The result is used both for graph inspection and to explain why a new
    /// edge would create a cycle.
    pub fn find_path(&self, start: &str, target: &str) -> Option<Vec<String>> {
        if start == target {
            return Some(vec![start.to_string()]);
        }
        use std::collections::{HashSet, VecDeque};
        let mut visited: HashSet<&str> = HashSet::new();
        let mut queue: VecDeque<Vec<String>> = VecDeque::new();

        visited.insert(start);
        queue.push_back(vec![start.to_string()]);

        while let Some(path) = queue.pop_front() {
            let current = path.last().unwrap();
            for conn in &self.connections {
                if conn.from_id == *current {
                    if conn.to_id == target {
                        let mut full_path = path.clone();
                        full_path.push(target.to_string());
                        return Some(full_path);
                    }
                    if visited.insert(&conn.to_id) {
                        let mut new_path = path.clone();
                        new_path.push(conn.to_id.clone());
                        queue.push_back(new_path);
                    }
                }
            }
        }
        None
    }

    /// Validates an edge against endpoint, duplicate, self-cycle, and cycle
    /// invariants without mutating the document.
    pub fn can_connect(&self, from_id: &str, to_id: &str) -> Result<(), ConnectionError> {
        if self.find_card(from_id).is_none() {
            return Err(ConnectionError::SourceCardNotFound(from_id.to_string()));
        }
        if self.find_card(to_id).is_none() {
            return Err(ConnectionError::TargetCardNotFound(to_id.to_string()));
        }
        if from_id == to_id {
            return Err(ConnectionError::SelfCycle(from_id.to_string()));
        }
        if self.has_connection(from_id, to_id) {
            return Err(ConnectionError::AlreadyConnected(
                from_id.to_string(),
                to_id.to_string(),
            ));
        }
        if let Some(path) = self.find_path(to_id, from_id) {
            return Err(ConnectionError::CreatesCycle { path });
        }
        Ok(())
    }

    /// Validates and then inserts a directed Prerequisite edge atomically.
    pub fn try_add_connection(
        &mut self,
        from_id: impl Into<String>,
        to_id: impl Into<String>,
    ) -> Result<(), ConnectionError> {
        let from_id = from_id.into();
        let to_id = to_id.into();
        self.can_connect(&from_id, &to_id)?;
        self.add_connection(PrerequisiteConnection::new(from_id, to_id));
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Reasons an attempted Prerequisite edge cannot be added.
pub enum ConnectionError {
    SourceCardNotFound(String),
    TargetCardNotFound(String),
    SelfCycle(String),
    AlreadyConnected(String, String),
    CreatesCycle { path: Vec<String> },
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceCardNotFound(id) => write!(f, "Source skill card '{}' not found", id),
            Self::TargetCardNotFound(id) => write!(f, "Target skill card '{}' not found", id),
            Self::SelfCycle(id) => write!(
                f,
                "Cannot connect '{}' to itself: self-prerequisite creates an immediate cycle",
                id
            ),
            Self::AlreadyConnected(from, to) => write!(
                f,
                "Prerequisite connection from '{}' to '{}' already exists",
                from, to
            ),
            Self::CreatesCycle { path } => {
                write!(f, "Cannot connect: creates a cycle ({})", path.join(" → "))
            }
        }
    }
}

impl std::error::Error for ConnectionError {}
