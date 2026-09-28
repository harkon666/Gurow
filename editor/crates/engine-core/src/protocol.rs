use crate::document::{CanvasDocument, PrerequisiteConnection, SkillCard};
use crate::geometry::{Point, Rect, Size};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// Selection information emitted across the Rust/TypeScript boundary.
pub struct SelectionChange {
    pub selected_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// Screen-space geometry and identity used to position an HTML Skill label.
pub struct LabelLayout {
    pub card_id: String,
    pub title: String,
    pub screen_rect: Rect,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
/// Commands accepted by the Wasm editor boundary.
///
/// Coordinates in pointer, camera, and viewport commands are CSS-pixel
/// coordinates. The renderer may use a higher-resolution physical canvas.
pub enum EditorCommand {
    LoadDocument {
        document: CanvasDocument,
    },
    CreateCard {
        id: String,
        title: String,
        position: Point,
        size: Option<Size>,
    },
    SelectCard {
        id: Option<String>,
    },
    PointerDown {
        screen_x: f32,
        screen_y: f32,
    },
    PointerMove {
        screen_x: f32,
        screen_y: f32,
    },
    PointerUp {
        screen_x: f32,
        screen_y: f32,
    },
    PanCamera {
        delta_x: f32,
        delta_y: f32,
    },
    ZoomAt {
        screen_x: f32,
        screen_y: f32,
        factor: f32,
    },
    Undo,
    Redo,
    ResizeViewport {
        width: f32,
        height: f32,
    },
    ConnectSkills {
        from_id: String,
        to_id: String,
    },
    DisconnectSkills {
        from_id: String,
        to_id: String,
    },
    ExportSnapshot,
    SetCamera {
        offset_x: f32,
        offset_y: f32,
        zoom: f32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
/// State changes and diagnostics returned after a command is applied.
pub enum EditorEvent {
    DocumentLoaded,
    CardCreated { card: SkillCard },
    CardMoved {
        card_id: String,
        position: Point,
    },
    SelectionChanged {
        selected_id: Option<String>,
        title: Option<String>,
    },
    LabelsUpdated { labels: Vec<LabelLayout> },
    CameraChanged {
        offset_x: f32,
        offset_y: f32,
        zoom: f32,
    },
    HistoryChanged {
        can_undo: bool,
        can_redo: bool,
    },
    ConnectionCreated {
        from_id: String,
        to_id: String,
    },
    ConnectionDeleted {
        from_id: String,
        to_id: String,
    },
    ConnectionRejected {
        from_id: String,
        to_id: String,
        reason: String,
    },
    ConnectionsUpdated {
        connections: Vec<PrerequisiteConnection>,
    },
    SnapshotExported {
        document: CanvasDocument,
    },
    GpuError { message: String },
    Error { message: String },
}
