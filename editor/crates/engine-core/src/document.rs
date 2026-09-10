use crate::geometry::{Point, Rect, Size};
use serde::{Deserialize, Serialize};

pub const DEFAULT_CARD_WIDTH: f32 = 180.0;
pub const DEFAULT_CARD_HEIGHT: f32 = 80.0;

pub fn default_card_size() -> Size {
    Size::new(DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillCard {
    pub id: String,
    pub title: String,
    pub position: Point,
    #[serde(default = "default_card_size")]
    pub size: Size,
}


impl SkillCard {
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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CanvasDocument {
    pub cards: Vec<SkillCard>,
}

impl CanvasDocument {
    pub fn new() -> Self {
        Self { cards: Vec::new() }
    }

    pub fn add_card(&mut self, card: SkillCard) -> Result<(), String> {
        if self.cards.iter().any(|c| c.id == card.id) {
            return Err(format!("Card with id '{}' already exists", card.id));
        }
        self.cards.push(card);
        Ok(())
    }

    pub fn find_card(&self, id: &str) -> Option<&SkillCard> {
        self.cards.iter().find(|c| c.id == id)
    }
}

