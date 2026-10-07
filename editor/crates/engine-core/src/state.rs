use crate::document::{CanvasDocument, ConnectionError, SkillCard};
use crate::geometry::{Camera, Point, Rect, Size, MAX_WORLD_COORD, MIN_WORLD_COORD};
use crate::protocol::{EditorCommand, EditorEvent, LabelLayout, SelectionChange};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
/// Transient pointer interaction owned by the Rust editor state machine.
pub enum InteractionState {
    Idle,
    /// Moves every selected card by the pointer's movement. A press on one card
    /// drags that card alone; a press on a card of a multiselection drags them all.
    DraggingCards {
        /// The pressed card, which keeps its grab offset under the pointer.
        anchor_id: String,
        grab_offset_world: Point,
        /// Each dragged card with its position when the drag began.
        start_positions: Vec<(String, Point)>,
    },
    /// A box from the press point to the pointer selects the cards it touches.
    SelectingBox {
        origin_world: Point,
        current_world: Point,
    },
    Panning {
        last_screen_pos: Point,
    },
}

#[derive(Debug, Clone, PartialEq)]
/// One card's position before and after a move.
pub struct CardMove {
    pub card_id: String,
    pub from: Point,
    pub to: Point,
}

#[derive(Debug, Clone, PartialEq)]
/// Undoable editor operation. A completed drag is one history action, however
/// many selected cards it moved.
pub enum HistoryAction {
    MoveCards { moves: Vec<CardMove> },
}

#[derive(Debug, Clone, PartialEq)]
/// Complete live editor state owned by Rust between JSON commands.
///
/// The React application owns learning payloads; this state owns the canvas,
/// camera, selection, transient gesture, and editor history.
pub struct EditorState {
    pub document: CanvasDocument,
    pub camera: Camera,
    /// Selected cards in document order; session-only, never saved.
    pub selected_card_ids: Vec<String>,
    pub viewport_size: Size,
    pub interaction: InteractionState,
    pub undo_stack: Vec<HistoryAction>,
    pub redo_stack: Vec<HistoryAction>,
    /// Navigation only: pressing a card selects it and drags pan the view.
    pub read_only: bool,
    /// Positions only: cards can be dragged and the moves undone, but no card or
    /// connection can be added or removed.
    pub layout_only: bool,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            document: CanvasDocument::new(),
            camera: Camera::default(),
            selected_card_ids: Vec::new(),
            viewport_size: Size::new(800.0, 600.0),
            interaction: InteractionState::Idle,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            read_only: false,
            layout_only: false,
        }
    }
}

impl EditorState {
    /// Creates an editor with an empty document and default viewport/camera.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the viewport used by the camera and renderer, with a minimum of one pixel.
    pub fn set_viewport(&mut self, width: f32, height: f32) {
        self.viewport_size = Size::new(width.max(1.0), height.max(1.0));
    }

    /// Returns the topmost card containing a screen-space point.
    pub fn hit_test(&self, screen_pos: Point) -> Option<String> {
        let world_pos = self.camera.screen_to_world(screen_pos);
        for card in self.document.cards.iter().rev() {
            if card.world_bounds().contains(world_pos) {
                return Some(card.id.clone());
            }
        }
        None
    }

    /// The selected card when exactly one is selected: the Skill the application
    /// opens. A multiselection opens none.
    pub fn selected_card_id(&self) -> Option<&str> {
        match self.selected_card_ids.as_slice() {
            [id] => Some(id),
            _ => None,
        }
    }

    /// Selects one card (or none) and returns the event payload when it changed.
    pub fn select_card(&mut self, id: Option<String>) -> Option<SelectionChange> {
        self.set_selection(id.into_iter().collect())
    }

    /// Replaces the selection, kept in document order, and returns the event
    /// payload when it changed.
    pub fn set_selection(&mut self, ids: Vec<String>) -> Option<SelectionChange> {
        let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let ordered: Vec<String> = self
            .document
            .cards
            .iter()
            .filter(|card| wanted.contains(card.id.as_str()))
            .map(|card| card.id.clone())
            .collect();
        if self.selected_card_ids == ordered {
            return None;
        }
        self.selected_card_ids = ordered;
        let selected_id = self.selected_card_id().map(str::to_string);
        let title = selected_id
            .as_deref()
            .and_then(|cid| self.document.find_card(cid).map(|c| c.title.clone()));
        Some(SelectionChange {
            selected_id,
            title,
            selected_ids: self.selected_card_ids.clone(),
        })
    }

    fn push_selection_change(change: Option<SelectionChange>, events: &mut Vec<EditorEvent>) -> bool {
        match change {
            Some(change) => {
                events.push(EditorEvent::SelectionChanged {
                    selected_id: change.selected_id,
                    title: change.title,
                    selected_ids: change.selected_ids,
                });
                true
            }
            None => false,
        }
    }

    /// Cards whose bounds touch a world-space box, in document order.
    pub fn cards_in_box(&self, a: Point, b: Point) -> Vec<String> {
        let area = box_between(a, b);
        self.document
            .cards
            .iter()
            .filter(|card| card.world_bounds().intersects(&area))
            .map(|card| card.id.clone())
            .collect()
    }

    /// The selection box being drawn, in world space, for the renderer.
    pub fn selection_box(&self) -> Option<Rect> {
        match &self.interaction {
            InteractionState::SelectingBox {
                origin_world,
                current_world,
            } => Some(box_between(*origin_world, *current_world)),
            _ => None,
        }
    }

    /// Iterates cards paired with whether each card is currently selected.
    pub fn cards_with_selection(&self) -> impl Iterator<Item = (&SkillCard, bool)> {
        let selected: HashSet<&str> = self.selected_card_ids.iter().map(String::as_str).collect();
        self.document
            .cards
            .iter()
            .map(move |card| (card, selected.contains(card.id.as_str())))
    }

    /// Computes HTML-label world bounds; the camera reaches the overlay separately.
    pub fn get_label_layouts(&self) -> Vec<LabelLayout> {
        self.cards_with_selection()
            .map(|(card, selected)| LabelLayout {
                card_id: card.id.clone(),
                title: card.title.clone(),
                world_rect: card.world_bounds(),
                selected,
            })
            .collect()
    }

    /// Finds a directed Prerequisite path in the current document.
    pub fn find_path(&self, start: &str, target: &str) -> Option<Vec<String>> {
        self.document.find_path(start, target)
    }

    /// Cancels an in-progress gesture and emits any compensating card movement.
    /// A cancelled box keeps the selection it had reached.
    pub fn cancel_active_interaction(&mut self, events: &mut Vec<EditorEvent>) -> bool {
        match std::mem::replace(&mut self.interaction, InteractionState::Idle) {
            InteractionState::DraggingCards {
                start_positions, ..
            } => self.place_cards(start_positions.iter().map(|(id, from)| (id.as_str(), *from)), events),
            InteractionState::SelectingBox { .. }
            | InteractionState::Panning { .. }
            | InteractionState::Idle => false,
        }
    }

    /// Moves cards to the given positions, emitting a CardMoved for each card
    /// that actually moved. Returns whether any card moved. One pass over the
    /// document, so dragging a large selection stays linear in the card count.
    fn place_cards<'a>(
        &mut self,
        positions: impl Iterator<Item = (&'a str, Point)>,
        events: &mut Vec<EditorEvent>,
    ) -> bool {
        let positions: HashMap<&str, Point> = positions.collect();
        let mut moved = false;
        for card in &mut self.document.cards {
            let Some(&position) = positions.get(card.id.as_str()) else {
                continue;
            };
            if (card.position.x - position.x).abs() > 1e-5
                || (card.position.y - position.y).abs() > 1e-5
            {
                card.position = position;
                events.push(EditorEvent::CardMoved {
                    card_id: card.id.clone(),
                    position,
                });
                moved = true;
            }
        }
        moved
    }

    /// Moves the dragged cards so the anchor card keeps its grab offset under the
    /// pointer. The whole group moves by one delta, limited so that every card
    /// stays within the world bounds: relative positions never change.
    fn update_dragged_positions(
        &mut self,
        anchor_id: &str,
        grab_offset_world: Point,
        start_positions: &[(String, Point)],
        screen_pt: Point,
        events: &mut Vec<EditorEvent>,
    ) -> bool {
        let Some(anchor_start) = start_positions
            .iter()
            .find(|(id, _)| id == anchor_id)
            .map(|(_, start)| *start)
        else {
            return false;
        };
        let world_pointer = self.camera.screen_to_world(screen_pt);
        let mut delta = Point::new(
            world_pointer.x - grab_offset_world.x - anchor_start.x,
            world_pointer.y - grab_offset_world.y - anchor_start.y,
        );
        let (mut min, mut max) = (anchor_start, anchor_start);
        for (_, start) in start_positions {
            min = Point::new(min.x.min(start.x), min.y.min(start.y));
            max = Point::new(max.x.max(start.x), max.y.max(start.y));
        }
        delta.x = delta.x.min(MAX_WORLD_COORD - max.x).max(MIN_WORLD_COORD - min.x);
        delta.y = delta.y.min(MAX_WORLD_COORD - max.y).max(MIN_WORLD_COORD - min.y);
        self.place_cards(
            start_positions
                .iter()
                .map(|(id, start)| (id.as_str(), Point::new(start.x + delta.x, start.y + delta.y))),
            events,
        )
    }

    /// Applies one JSON-protocol command and returns the resulting events.
    ///
    /// The command is applied to CPU state first. The Wasm boundary then uses
    /// these events to render and update the React-side labels.
    pub fn apply_command(&mut self, cmd: EditorCommand) -> Vec<EditorEvent> {
        let mut events = Vec::new();
        let mut labels_changed = false;

        if self.read_only && cmd.edits_document() {
            events.push(EditorEvent::Error {
                message: "This canvas is read-only: its cards, positions and connections cannot be changed here".into(),
            });
            return events;
        }
        if self.layout_only && cmd.edits_content() {
            events.push(EditorEvent::Error {
                message: "Only card positions can be changed here: Skills and their connections stay as published".into(),
            });
            return events;
        }

        match cmd {
            EditorCommand::LoadDocument { document } => {
                self.document = document;
                self.undo_stack.clear();
                self.redo_stack.clear();
                self.interaction = InteractionState::Idle;
                // Selected cards that the loaded document still holds stay selected.
                let change = self.set_selection(self.selected_card_ids.clone());
                Self::push_selection_change(change, &mut events);
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
                let change = self.select_card(id);
                if Self::push_selection_change(change, &mut events) {
                    labels_changed = true;
                }
            }
            EditorCommand::PointerDown {
                screen_x,
                screen_y,
                shift_key,
            } => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                let screen_pt = Point::new(screen_x, screen_y);
                let hit = self.hit_test(screen_pt);
                if let Some(card_id) = hit {
                    // Pressing a card of the selection keeps it, so the whole selection drags.
                    let keep_selection = !self.read_only && self.selected_card_ids.contains(&card_id);
                    if !keep_selection {
                        let change = self.select_card(Some(card_id.clone()));
                        if Self::push_selection_change(change, &mut events) {
                            labels_changed = true;
                        }
                    }
                    if self.read_only {
                        self.interaction = InteractionState::Panning {
                            last_screen_pos: screen_pt,
                        };
                    } else if let Some(card) = self.document.find_card(&card_id) {
                        let world_pointer = self.camera.screen_to_world(screen_pt);
                        let grab_offset_world = Point::new(
                            world_pointer.x - card.position.x,
                            world_pointer.y - card.position.y,
                        );
                        let start_positions = self
                            .document
                            .cards
                            .iter()
                            .filter(|c| self.selected_card_ids.contains(&c.id))
                            .map(|c| (c.id.clone(), c.position))
                            .collect();
                        self.interaction = InteractionState::DraggingCards {
                            anchor_id: card_id,
                            grab_offset_world,
                            start_positions,
                        };
                    }
                } else if shift_key && !self.read_only {
                    // Shift on the empty canvas draws a selection box instead of panning.
                    let origin_world = self.camera.screen_to_world(screen_pt);
                    self.interaction = InteractionState::SelectingBox {
                        origin_world,
                        current_world: origin_world,
                    };
                    let change = self.set_selection(self.cards_in_box(origin_world, origin_world));
                    if Self::push_selection_change(change, &mut events) {
                        labels_changed = true;
                    }
                } else {
                    let change = self.select_card(None);
                    if Self::push_selection_change(change, &mut events) {
                        labels_changed = true;
                    }
                    self.interaction = InteractionState::Panning {
                        last_screen_pos: screen_pt,
                    };
                }
            }
            EditorCommand::PointerMove { screen_x, screen_y } => {
                let screen_pt = Point::new(screen_x, screen_y);
                match std::mem::replace(&mut self.interaction, InteractionState::Idle) {
                    InteractionState::DraggingCards {
                        anchor_id,
                        grab_offset_world,
                        start_positions,
                    } => {
                        if self.update_dragged_positions(
                            &anchor_id,
                            grab_offset_world,
                            &start_positions,
                            screen_pt,
                            &mut events,
                        ) {
                            labels_changed = true;
                        }
                        self.interaction = InteractionState::DraggingCards {
                            anchor_id,
                            grab_offset_world,
                            start_positions,
                        };
                    }
                    InteractionState::SelectingBox { origin_world, .. } => {
                        let current_world = self.camera.screen_to_world(screen_pt);
                        self.interaction = InteractionState::SelectingBox {
                            origin_world,
                            current_world,
                        };
                        let change = self.set_selection(self.cards_in_box(origin_world, current_world));
                        if Self::push_selection_change(change, &mut events) {
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
                        } else {
                            self.interaction = InteractionState::Panning { last_screen_pos };
                        }
                    }
                    InteractionState::Idle => {}
                }
            }
            EditorCommand::PointerUp { screen_x, screen_y } => {
                let screen_pt = Point::new(screen_x, screen_y);
                match std::mem::replace(&mut self.interaction, InteractionState::Idle) {
                    InteractionState::DraggingCards {
                        anchor_id,
                        grab_offset_world,
                        start_positions,
                    } => {
                        if self.update_dragged_positions(
                            &anchor_id,
                            grab_offset_world,
                            &start_positions,
                            screen_pt,
                            &mut events,
                        ) {
                            labels_changed = true;
                        }
                        let moves: Vec<CardMove> = start_positions
                            .into_iter()
                            .filter_map(|(card_id, from)| {
                                let to = self.document.find_card(&card_id)?.position;
                                let moved = (to.x - from.x).abs() > 1e-4 || (to.y - from.y).abs() > 1e-4;
                                moved.then_some(CardMove { card_id, from, to })
                            })
                            .collect();
                        if !moves.is_empty() {
                            self.undo_stack.push(HistoryAction::MoveCards { moves });
                            self.redo_stack.clear();
                            events.push(EditorEvent::HistoryChanged {
                                can_undo: true,
                                can_redo: false,
                            });
                        }
                    }
                    InteractionState::SelectingBox { origin_world, .. } => {
                        let current_world = self.camera.screen_to_world(screen_pt);
                        let change = self.set_selection(self.cards_in_box(origin_world, current_world));
                        if Self::push_selection_change(change, &mut events) {
                            labels_changed = true;
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
            }
            EditorCommand::Undo => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if let Some(HistoryAction::MoveCards { moves }) = self.undo_stack.pop() {
                    if self.place_cards(moves.iter().map(|m| (m.card_id.as_str(), m.from)), &mut events) {
                        labels_changed = true;
                    }
                    self.redo_stack.push(HistoryAction::MoveCards { moves });
                    events.push(EditorEvent::HistoryChanged {
                        can_undo: !self.undo_stack.is_empty(),
                        can_redo: true,
                    });
                }
            }
            EditorCommand::Redo => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if let Some(HistoryAction::MoveCards { moves }) = self.redo_stack.pop() {
                    if self.place_cards(moves.iter().map(|m| (m.card_id.as_str(), m.to)), &mut events) {
                        labels_changed = true;
                    }
                    self.undo_stack.push(HistoryAction::MoveCards { moves });
                    events.push(EditorEvent::HistoryChanged {
                        can_undo: true,
                        can_redo: !self.redo_stack.is_empty(),
                    });
                }
            }
            EditorCommand::ResizeViewport { width, height } => {
                self.set_viewport(width, height);
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
            EditorCommand::ExportSnapshot => {
                events.push(EditorEvent::SnapshotExported {
                    document: self.document.clone(),
                });
            }
            EditorCommand::SetCamera {
                offset_x,
                offset_y,
                zoom,
            } => {
                self.camera = Camera::new(offset_x, offset_y, zoom);
                events.push(EditorEvent::CameraChanged {
                    offset_x: self.camera.offset_x,
                    offset_y: self.camera.offset_y,
                    zoom: self.camera.zoom,
                });
            }
            EditorCommand::SetReadOnly { read_only } => {
                // A drag in progress would otherwise finish as a move after the switch.
                if read_only && self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                self.read_only = read_only;
            }
            EditorCommand::SetLayoutOnly { layout_only } => {
                self.layout_only = layout_only;
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

/// The axis-aligned box spanned by two corner points.
fn box_between(a: Point, b: Point) -> Rect {
    Rect::new(a.x.min(b.x), a.y.min(b.y), (a.x - b.x).abs(), (a.y - b.y).abs())
}
