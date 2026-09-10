use crate::document::{CanvasDocument, SkillCard};
use crate::geometry::{Point, Rect, Size};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectionChange {
    pub selected_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelLayout {
    pub card_id: String,
    pub title: String,
    pub screen_rect: Rect,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
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
    ResizeViewport {
        width: f32,
        height: f32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EditorEvent {
    DocumentLoaded,
    CardCreated { card: SkillCard },
    SelectionChanged {
        selected_id: Option<String>,
        title: Option<String>,
    },
    LabelsUpdated { labels: Vec<LabelLayout> },
    GpuError { message: String },
    Error { message: String },
}

