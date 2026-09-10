use crate::document::{CanvasDocument, SkillCard};
use crate::geometry::{Camera, Point, Size};
use crate::protocol::{EditorCommand, EditorEvent, LabelLayout, SelectionChange};

#[derive(Debug, Clone, PartialEq)]
pub struct EditorState {
    pub document: CanvasDocument,
    pub camera: Camera,
    pub selected_card_id: Option<String>,
    pub viewport_size: Size,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            document: CanvasDocument::new(),
            camera: Camera::default(),
            selected_card_id: None,
            viewport_size: Size::new(800.0, 600.0),
        }
    }
}

impl EditorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_viewport(&mut self, width: f32, height: f32) {
        self.viewport_size = Size::new(width.max(1.0), height.max(1.0));
    }

    pub fn hit_test(&self, screen_pos: Point) -> Option<String> {
        let world_pos = self.camera.screen_to_world(screen_pos);
        for card in self.document.cards.iter().rev() {
            if card.world_bounds().contains(world_pos) {
                return Some(card.id.clone());
            }
        }
        None
    }

    pub fn select_card(&mut self, id: Option<String>) -> Option<SelectionChange> {
        if self.selected_card_id != id {
            self.selected_card_id = id.clone();
            let title = id
                .as_deref()
                .and_then(|cid| self.document.find_card(cid).map(|c| c.title.clone()));
            Some(SelectionChange {
                selected_id: id,
                title,
            })
        } else {
            None
        }
    }

    pub fn cards_with_selection(&self) -> impl Iterator<Item = (&SkillCard, bool)> {
        self.document.cards.iter().map(|card| {
            let is_selected = self.selected_card_id.as_deref() == Some(&card.id);
            (card, is_selected)
        })
    }

    pub fn get_label_layouts(&self) -> Vec<LabelLayout> {
        self.document
            .cards
            .iter()
            .map(|card| {
                let world_rect = card.world_bounds();
                let screen_rect = self.camera.world_rect_to_screen(world_rect);
                let selected = self.selected_card_id.as_deref() == Some(&card.id);
                LabelLayout {
                    card_id: card.id.clone(),
                    title: card.title.clone(),
                    screen_rect,
                    selected,
                }
            })
            .collect()
    }

    pub fn apply_command(&mut self, cmd: EditorCommand) -> Vec<EditorEvent> {
        let mut events = Vec::new();
        let mut labels_changed = false;

        match cmd {
            EditorCommand::LoadDocument { document } => {
                self.document = document;
                if let Some(ref sel) = self.selected_card_id {
                    if !self.document.cards.iter().any(|c| &c.id == sel) {
                        self.selected_card_id = None;
                        events.push(EditorEvent::SelectionChanged {
                            selected_id: None,
                            title: None,
                        });
                    }
                }
                events.push(EditorEvent::DocumentLoaded);
                labels_changed = true;
            }
            EditorCommand::CreateCard {
                id,
                title,
                position,
                size,
            } => {
                let card = SkillCard::new(&id, &title, position, size);
                match self.document.add_card(card.clone()) {
                    Ok(()) => {
                        events.push(EditorEvent::CardCreated { card });
                        labels_changed = true;
                    }
                    Err(err) => {
                        events.push(EditorEvent::Error { message: err });
                    }
                }
            }
            EditorCommand::SelectCard { id } => {
                if let Some(change) = self.select_card(id) {
                    events.push(EditorEvent::SelectionChanged {
                        selected_id: change.selected_id,
                        title: change.title,
                    });
                    labels_changed = true;
                }
            }
            EditorCommand::PointerDown { screen_x, screen_y } => {
                let hit = self.hit_test(Point::new(screen_x, screen_y));
                if let Some(change) = self.select_card(hit) {
                    events.push(EditorEvent::SelectionChanged {
                        selected_id: change.selected_id,
                        title: change.title,
                    });
                    labels_changed = true;
                }
            }
            EditorCommand::ResizeViewport { width, height } => {
                self.set_viewport(width, height);
                labels_changed = true;
            }
        }

        if labels_changed {
            events.push(EditorEvent::LabelsUpdated {
                labels: self.get_label_layouts(),
            });
        }

        events
    }
}

