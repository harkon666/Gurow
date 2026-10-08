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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
/// How `ArrangeSelection` lines up the selected cards. Alignments line one edge
/// or centre up with the selection's bounds; distributions leave equal gaps
/// between neighbours, keeping the outermost cards where they are.
pub enum Arrangement {
    AlignLeft,
    AlignCenter,
    AlignRight,
    AlignTop,
    AlignMiddle,
    AlignBottom,
    DistributeHorizontally,
    DistributeVertically,
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
    /// instead of panning; on a card, it adds the card to the selection or takes
    /// it out. On an editable canvas, a press on a card's connection
    /// point starts a connection drag instead of moving the card; a press near a
    /// connection on the empty canvas selects that connection.
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
    /// Ends the gesture in progress without completing it: a card drag returns its
    /// cards, a connection drag adds nothing.
    CancelInteraction,
    /// Selects one connection (or none) for deletion; selecting one clears the
    /// card selection.
    SelectConnection {
        connection: Option<PrerequisiteConnection>,
    },
    /// Selects every card.
    SelectAll,
    /// Moves the selected cards by a world-space step. Consecutive steps of the
    /// same cards, with no other edit, undo or redo between, are one undo step.
    NudgeSelection {
        delta_x: f32,
        delta_y: f32,
    },
    /// Aligns or spaces out the selected cards, as one undo step.
    ArrangeSelection {
        arrangement: Arrangement,
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
    /// Deletes a card with its connections, as one undo step. Whether the Skill may
    /// be deleted (no learning history) is the application's and backend's decision.
    DeleteCard {
        id: String,
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
        self.edits_content()
            || matches!(
                self,
                EditorCommand::Undo
                    | EditorCommand::Redo
                    | EditorCommand::NudgeSelection { .. }
                    | EditorCommand::ArrangeSelection { .. }
            )
    }

    /// Whether the command changes which cards or connections the document has,
    /// which a layout-only canvas refuses. Moves, and undoing them, only change positions.
    pub fn edits_content(&self) -> bool {
        matches!(
            self,
            EditorCommand::CreateCard { .. }
                | EditorCommand::DeleteCard { .. }
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
    /// A card left the document (a deletion, or the redo of one) with its connections.
    CardDeleted {
        card_id: String,
    },
    /// A deleted card came back (the undo of a deletion) with its connections.
    CardRestored {
        card_id: String,
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
    /// A drag from `from_id`'s connection point began. `valid_target_ids` are the
    /// cards the graph accepts as its Prerequisite dependents (no self-connection,
    /// duplicate or cycle); the application may refuse more by its own rules.
    ConnectionDragStarted {
        from_id: String,
        valid_target_ids: Vec<String>,
    },
    /// The card under the pointer during a connection drag changed.
    ConnectionDragTargetChanged {
        target_id: Option<String>,
    },
    /// The connection drag ended. `dropped_on` names the card it was released on;
    /// it is `None` when cancelled or released on the empty canvas. A drop only
    /// proposes `from_id` → `dropped_on`: the application validates it and sends
    /// `ConnectSkills`, the same command as the non-drag action.
    ConnectionDragEnded {
        from_id: String,
        dropped_on: Option<String>,
    },
    /// The selected connection changed (`None` when no connection is selected).
    ConnectionSelected {
        connection: Option<PrerequisiteConnection>,
    },
    SnapshotExported {
        document: CanvasDocument,
    },
    GpuError { message: String },
    Error { message: String },
}
