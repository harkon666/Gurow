pub mod document;
pub mod geometry;
pub mod protocol;
pub mod state;

#[cfg(test)]
mod tests;

pub use document::{CanvasDocument, PrerequisiteConnection, SkillCard};
pub use geometry::{
    clamp_world_coord, clamp_world_point, connection_curve, connection_route, connection_route_to_point, cubic_point,
    cubic_tangent, facing_sides, Camera, Point, Rect, Side, Size,
    CONNECTION_CURVE_SEGMENTS, MAX_WORLD_COORD, MAX_ZOOM, MIN_WORLD_COORD, MIN_ZOOM,
};
pub use protocol::{Arrangement, EditorCommand, EditorEvent, LabelLayout, SelectionChange};
pub use state::{CardMove, ConnectionPreview, EditorState, HistoryAction, InteractionState};

