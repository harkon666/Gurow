pub mod document;
pub mod geometry;
pub mod protocol;
pub mod state;

#[cfg(test)]
mod tests;

pub use document::{CanvasDocument, SkillCard};
pub use geometry::{
    clamp_world_coord, clamp_world_point, Camera, Point, Rect, Size, MAX_WORLD_COORD, MAX_ZOOM,
    MIN_WORLD_COORD, MIN_ZOOM,
};
pub use protocol::{EditorCommand, EditorEvent, LabelLayout, SelectionChange};
pub use state::{EditorState, HistoryAction, InteractionState};

