use crate::document::{CanvasDocument, PrerequisiteConnection, SkillCard};
use crate::geometry::{Point, Rect, Size};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// Selection information emitted across the Rust/TypeScript boundary.
pub struct SelectionChange {
    /// The selected card when exactly one is selected.
    pub selected_id: Option<String>,
    pub title: Option<String>,
    /// Every selected card, in document order.
    pub selected_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// World-space card bounds and identity for an HTML Skill label.
///
/// Labels do not depend on the camera: the overlay applies the camera from
/// `CameraChanged` as one transform, so camera-only commands never re-send them.
pub struct LabelLayout {
    pub card_id: String,
    pub title: String,
    pub world_rect: Rect,
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
    /// With `shift_key` on the empty canvas, the press starts a selection box
    /// instead of panning.
    PointerDown {
        screen_x: f32,
        screen_y: f32,
        #[serde(default)]
        shift_key: bool,
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
    /// A read-only canvas can be panned, zoomed and selected, but its document
    /// (cards, positions, connections) cannot be edited.
    SetReadOnly {
        read_only: bool,
    },
    /// A layout-only canvas also allows moving cards and undoing or redoing those
    /// moves, but refuses adding cards and changing connections: the shared Canvas
    /// Layout of a published Version, whose learning content is immutable.
    SetLayoutOnly {
        layout_only: bool,
    },
}

impl EditorCommand {
    /// Whether the command changes the document or its edit history, which a
    /// read-only canvas refuses. Loading a document replaces it rather than editing it.
    pub fn edits_document(&self) -> bool {
        self.edits_content() || matches!(self, EditorCommand::Undo | EditorCommand::Redo)
    }

    /// Whether the command changes which cards or connections the document has,
    /// which a layout-only canvas refuses. Moves, and undoing them, only change positions.
    pub fn edits_content(&self) -> bool {
        matches!(
            self,
            EditorCommand::CreateCard { .. }
                | EditorCommand::ConnectSkills { .. }
                | EditorCommand::DisconnectSkills { .. }
        )
    }
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
    /// `selected_id` names the selected card when exactly one is selected;
    /// `selected_ids` lists every selected card.
    SelectionChanged {
        selected_id: Option<String>,
        title: Option<String>,
        selected_ids: Vec<String>,
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
