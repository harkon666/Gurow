use crate::document::{CanvasDocument, ConnectionError, SkillCard};
use crate::geometry::{clamp_world_point, Camera, Point, Size};
use crate::protocol::{EditorCommand, EditorEvent, LabelLayout, SelectionChange};

#[derive(Debug, Clone, PartialEq)]
pub enum InteractionState {
    Idle,
    DraggingCard {
        card_id: String,
        start_position: Point,
        grab_offset_world: Point,
    },
    Panning {
        last_screen_pos: Point,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum HistoryAction {
    MoveCard {
        card_id: String,
        from: Point,
        to: Point,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct EditorState {
    pub document: CanvasDocument,
    pub camera: Camera,
    pub selected_card_id: Option<String>,
    pub viewport_size: Size,
    pub interaction: InteractionState,
    pub undo_stack: Vec<HistoryAction>,
    pub redo_stack: Vec<HistoryAction>,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            document: CanvasDocument::new(),
            camera: Camera::default(),
            selected_card_id: None,
            viewport_size: Size::new(800.0, 600.0),
            interaction: InteractionState::Idle,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
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

    pub fn find_path(&self, start: &str, target: &str) -> Option<Vec<String>> {
        self.document.find_path(start, target)
    }

    pub fn cancel_active_interaction(&mut self, events: &mut Vec<EditorEvent>) -> bool {
        let mut labels_changed = false;
        match std::mem::replace(&mut self.interaction, InteractionState::Idle) {
            InteractionState::DraggingCard {
                card_id,
                start_position,
                ..
            } => {
                if let Some(card) = self.document.cards.iter_mut().find(|c| c.id == card_id) {
                    if (card.position.x - start_position.x).abs() > 1e-5
                        || (card.position.y - start_position.y).abs() > 1e-5
                    {
                        card.position = start_position;
                        events.push(EditorEvent::CardMoved {
                            card_id,
                            position: start_position,
                        });
                        labels_changed = true;
                    }
                }
            }
            InteractionState::Panning { .. } | InteractionState::Idle => {}
        }
        labels_changed
    }

    fn update_dragged_card_position(
        &mut self,
        card_id: &str,
        grab_offset_world: Point,
        screen_pt: Point,
        events: &mut Vec<EditorEvent>,
    ) -> (Option<Point>, bool) {
        let world_pointer = self.camera.screen_to_world(screen_pt);
        let target_pos = clamp_world_point(Point::new(
            world_pointer.x - grab_offset_world.x,
            world_pointer.y - grab_offset_world.y,
        ));
        let mut labels_changed = false;
        let mut actual_pos = None;

        if let Some(card) = self.document.cards.iter_mut().find(|c| c.id == card_id) {
            if (card.position.x - target_pos.x).abs() > 1e-5
                || (card.position.y - target_pos.y).abs() > 1e-5
            {
                card.position = target_pos;
                events.push(EditorEvent::CardMoved {
                    card_id: card_id.to_string(),
                    position: target_pos,
                });
                labels_changed = true;
            }
            actual_pos = Some(card.position);
        }

        (actual_pos, labels_changed)
    }

    pub fn apply_command(&mut self, cmd: EditorCommand) -> Vec<EditorEvent> {
        let mut events = Vec::new();
        let mut labels_changed = false;

        match cmd {
            EditorCommand::LoadDocument { document } => {
                self.document = document;
                self.undo_stack.clear();
                self.redo_stack.clear();
                self.interaction = InteractionState::Idle;
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
                events.push(EditorEvent::ConnectionsUpdated {
                    connections: self.document.connections.clone(),
                });
                events.push(EditorEvent::HistoryChanged {
                    can_undo: false,
                    can_redo: false,
                });
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
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if let Some(change) = self.select_card(id) {
                    events.push(EditorEvent::SelectionChanged {
                        selected_id: change.selected_id,
                        title: change.title,
                    });
                    labels_changed = true;
                }
            }
            EditorCommand::PointerDown { screen_x, screen_y } => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                let screen_pt = Point::new(screen_x, screen_y);
                let hit = self.hit_test(screen_pt);
                if let Some(ref card_id) = hit {
                    if let Some(change) = self.select_card(hit.clone()) {
                        events.push(EditorEvent::SelectionChanged {
                            selected_id: change.selected_id,
                            title: change.title,
                        });
                        labels_changed = true;
                    }
                    if let Some(card) = self.document.find_card(card_id) {
                        let world_pointer = self.camera.screen_to_world(screen_pt);
                        let grab_offset_world = Point::new(
                            world_pointer.x - card.position.x,
                            world_pointer.y - card.position.y,
                        );
                        self.interaction = InteractionState::DraggingCard {
                            card_id: card_id.clone(),
                            start_position: card.position,
                            grab_offset_world,
                        };
                    }
                } else {
                    if let Some(change) = self.select_card(None) {
                        events.push(EditorEvent::SelectionChanged {
                            selected_id: change.selected_id,
                            title: change.title,
                        });
                        labels_changed = true;
                    }
                    self.interaction = InteractionState::Panning {
                        last_screen_pos: screen_pt,
                    };
                }
            }
            EditorCommand::PointerMove { screen_x, screen_y } => {
                let screen_pt = Point::new(screen_x, screen_y);
                match &self.interaction {
                    InteractionState::DraggingCard {
                        card_id,
                        grab_offset_world,
                        ..
                    } => {
                        let card_id = card_id.clone();
                        let grab_offset = *grab_offset_world;
                        let (_, moved) = self.update_dragged_card_position(
                            &card_id,
                            grab_offset,
                            screen_pt,
                            &mut events,
                        );
                        if moved {
                            labels_changed = true;
                        }
                    }
                    InteractionState::Panning { last_screen_pos } => {
                        let delta_x = screen_x - last_screen_pos.x;
                        let delta_y = screen_y - last_screen_pos.y;
                        if delta_x.abs() > 1e-5 || delta_y.abs() > 1e-5 {
                            self.camera.pan(delta_x, delta_y);
                            self.interaction = InteractionState::Panning {
                                last_screen_pos: screen_pt,
                            };
                            events.push(EditorEvent::CameraChanged {
                                offset_x: self.camera.offset_x,
                                offset_y: self.camera.offset_y,
                                zoom: self.camera.zoom,
                            });
                            labels_changed = true;
                        }
                    }
                    InteractionState::Idle => {}
                }
            }
            EditorCommand::PointerUp { screen_x, screen_y } => {
                let screen_pt = Point::new(screen_x, screen_y);
                match std::mem::replace(&mut self.interaction, InteractionState::Idle) {
                    InteractionState::DraggingCard {
                        card_id,
                        start_position,
                        grab_offset_world,
                    } => {
                        let (card_pos, moved) = self.update_dragged_card_position(
                            &card_id,
                            grab_offset_world,
                            screen_pt,
                            &mut events,
                        );
                        if moved {
                            labels_changed = true;
                        }
                        if let Some(pos) = card_pos {
                            if (pos.x - start_position.x).abs() > 1e-4
                                || (pos.y - start_position.y).abs() > 1e-4
                            {
                                self.undo_stack.push(HistoryAction::MoveCard {
                                    card_id,
                                    from: start_position,
                                    to: pos,
                                });
                                self.redo_stack.clear();
                                events.push(EditorEvent::HistoryChanged {
                                    can_undo: true,
                                    can_redo: false,
                                });
                            }
                        }
                    }
                    InteractionState::Panning { .. } | InteractionState::Idle => {}
                }
            }
            EditorCommand::PanCamera { delta_x, delta_y } => {
                self.camera.pan(delta_x, delta_y);
                events.push(EditorEvent::CameraChanged {
                    offset_x: self.camera.offset_x,
                    offset_y: self.camera.offset_y,
                    zoom: self.camera.zoom,
                });
                labels_changed = true;
            }
            EditorCommand::ZoomAt {
                screen_x,
                screen_y,
                factor,
            } => {
                self.camera
                    .zoom_at(Point::new(screen_x, screen_y), factor);
                events.push(EditorEvent::CameraChanged {
                    offset_x: self.camera.offset_x,
                    offset_y: self.camera.offset_y,
                    zoom: self.camera.zoom,
                });
                labels_changed = true;
            }
            EditorCommand::Undo => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if let Some(action) = self.undo_stack.pop() {
                    match action {
                        HistoryAction::MoveCard { card_id, from, to } => {
                            if let Some(card) = self.document.cards.iter_mut().find(|c| c.id == card_id) {
                                card.position = from;
                                events.push(EditorEvent::CardMoved {
                                    card_id: card_id.clone(),
                                    position: from,
                                });
                                labels_changed = true;
                            }
                            self.redo_stack.push(HistoryAction::MoveCard {
                                card_id,
                                from,
                                to,
                            });
                            events.push(EditorEvent::HistoryChanged {
                                can_undo: !self.undo_stack.is_empty(),
                                can_redo: true,
                            });
                        }
                    }
                }
            }
            EditorCommand::Redo => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if let Some(action) = self.redo_stack.pop() {
                    match action {
                        HistoryAction::MoveCard { card_id, from, to } => {
                            if let Some(card) = self.document.cards.iter_mut().find(|c| c.id == card_id) {
                                card.position = to;
                                events.push(EditorEvent::CardMoved {
                                    card_id: card_id.clone(),
                                    position: to,
                                });
                                labels_changed = true;
                            }
                            self.undo_stack.push(HistoryAction::MoveCard {
                                card_id,
                                from,
                                to,
                            });
                            events.push(EditorEvent::HistoryChanged {
                                can_undo: true,
                                can_redo: !self.redo_stack.is_empty(),
                            });
                        }
                    }
                }
            }
            EditorCommand::ResizeViewport { width, height } => {
                self.set_viewport(width, height);
                labels_changed = true;
            }
            EditorCommand::ConnectSkills { from_id, to_id } => {
                match self.document.try_add_connection(&from_id, &to_id) {
                    Ok(()) => {
                        events.push(EditorEvent::ConnectionCreated {
                            from_id: from_id.clone(),
                            to_id: to_id.clone(),
                        });
                        events.push(EditorEvent::ConnectionsUpdated {
                            connections: self.document.connections.clone(),
                        });
                    }
                    Err(ConnectionError::SourceCardNotFound(id)) => {
                        events.push(EditorEvent::ConnectionRejected {
                            from_id: from_id.clone(),
                            to_id: to_id.clone(),
                            reason: format!("Source skill card '{}' not found", id),
                        });
                    }
                    Err(ConnectionError::TargetCardNotFound(id)) => {
                        events.push(EditorEvent::ConnectionRejected {
                            from_id: from_id.clone(),
                            to_id: to_id.clone(),
                            reason: format!("Target skill card '{}' not found", id),
                        });
                    }
                    Err(ConnectionError::SelfCycle(id)) => {
                        events.push(EditorEvent::ConnectionRejected {
                            from_id: from_id.clone(),
                            to_id: to_id.clone(),
                            reason: format!(
                                "Cannot connect '{}' to itself: self-prerequisite creates an immediate cycle",
                                id
                            ),
                        });
                    }
                    Err(ConnectionError::AlreadyConnected(from, to)) => {
                        events.push(EditorEvent::ConnectionRejected {
                            from_id: from_id.clone(),
                            to_id: to_id.clone(),
                            reason: format!(
                                "Prerequisite connection from '{}' to '{}' already exists",
                                from, to
                            ),
                        });
                    }
                    Err(ConnectionError::CreatesCycle { path }) => {
                        let cycle_display: Vec<String> = std::iter::once(&from_id)
                            .chain(path.iter())
                            .map(|id| {
                                self.document
                                    .find_card(id)
                                    .map(|c| format!("{} ({})", c.title, id))
                                    .unwrap_or_else(|| id.clone())
                            })
                            .collect();
                        let reason = format!(
                            "Cannot connect: creates a cycle ({}). Prerequisite graph must remain acyclic (DAG).",
                            cycle_display.join(" → ")
                        );
                        events.push(EditorEvent::ConnectionRejected {
                            from_id,
                            to_id,
                            reason,
                        });
                    }
                }
            }
            EditorCommand::DisconnectSkills { from_id, to_id } => {
                if self.document.remove_connection(&from_id, &to_id) {
                    events.push(EditorEvent::ConnectionDeleted {
                        from_id: from_id.clone(),
                        to_id: to_id.clone(),
                    });
                    events.push(EditorEvent::ConnectionsUpdated {
                        connections: self.document.connections.clone(),
                    });
                } else {
                    events.push(EditorEvent::Error {
                        message: format!("Connection from '{}' to '{}' does not exist", from_id, to_id),
                    });
                }
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

