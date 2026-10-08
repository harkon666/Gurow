use crate::document::{CanvasDocument, ConnectionError, PrerequisiteConnection, SkillCard};
use crate::geometry::{
    connection_route, connection_route_to_point, cubic_point, distance_to_segment, Camera, Point, Rect, Side, Size,
    CONNECTION_CURVE_SEGMENTS, CONNECTION_HANDLE_RADIUS_PX, CONNECTION_HIT_TOLERANCE_PX,
    MAX_WORLD_COORD, MIN_WORLD_COORD,
};
use crate::protocol::{Arrangement, EditorCommand, EditorEvent, LabelLayout, SelectionChange};
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
    /// A drag from a card's connection point. Nothing changes in the document
    /// until the drop, which only proposes the connection (`ConnectionDragEnded`).
    Connecting {
        from_id: String,
        pointer_world: Point,
        /// The card under the pointer, if any.
        target_id: Option<String>,
        /// Cards the graph accepts as a target, computed once at the press.
        valid_target_ids: Vec<String>,
        /// Whether the pointer has left the source card: releasing on it before
        /// then is a click on the connection point, not a self-connection attempt.
        left_source: bool,
    },
}

/// How the renderer draws the connection being dragged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConnectionPreview {
    /// The Bézier curve from the source card to the pointer, or to a valid target.
    pub curve: [Point; 4],
    /// Whether the card under the pointer is a valid target; `None` over the empty canvas.
    pub target_valid: Option<bool>,
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
/// many selected cards it moved; a deleted card is one with its connections.
/// Connection changes are actions too, so undoing in order never forms a cycle.
pub enum HistoryAction {
    MoveCards { moves: Vec<CardMove> },
    /// The card, its place in the document, and the connections it took along.
    DeleteCard {
        card: SkillCard,
        index: usize,
        connections: Vec<PrerequisiteConnection>,
    },
    AddConnection { connection: PrerequisiteConnection },
    RemoveConnection { connection: PrerequisiteConnection },
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
    /// The selected connection, offered for deletion; session-only, never saved.
    pub selected_connection: Option<PrerequisiteConnection>,
    /// The undo depth right after a `NudgeSelection` was recorded: a further step
    /// of the same cards joins it while no other edit, undo or redo has happened.
    pub nudge_depth: Option<usize>,
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
            selected_connection: None,
            nudge_depth: None,
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

    /// Whether cards and connections can be added or removed here.
    pub fn edits_content(&self) -> bool {
        !self.read_only && !self.layout_only
    }

    /// Returns the card whose visible connection point lies under a screen-space
    /// point. Each card has one in the middle of every side. Cards are tried front
    /// to back, and a card body under the point hides every connection point behind
    /// it, so a covered point never takes a press on the card in front. The points
    /// keep their screen size at every zoom, but never cover more than a quarter of
    /// a small card, so the card body stays draggable.
    pub fn hit_connection_point(&self, screen_pos: Point) -> Option<String> {
        let zoom = self.camera.zoom;
        let world_pos = self.camera.screen_to_world(screen_pos);
        for card in self.document.cards.iter().rev() {
            let radius = CONNECTION_HANDLE_RADIUS_PX
                .min(card.size.width.min(card.size.height) * zoom * 0.25)
                .max(2.0);
            let on_point = Side::ALL.iter().any(|&side| {
                let center = self.camera.world_to_screen(card.connection_handle(side));
                ((screen_pos.x - center.x).powi(2) + (screen_pos.y - center.y).powi(2)).sqrt() <= radius
            });
            if on_point {
                return Some(card.id.clone());
            }
            if card.world_bounds().contains(world_pos) {
                return None;
            }
        }
        None
    }

    /// Returns the connection drawn under a screen-space point, if any: the
    /// closest one within the hit tolerance.
    pub fn hit_connection(&self, screen_pos: Point) -> Option<PrerequisiteConnection> {
        let mut best: Option<(f32, &PrerequisiteConnection)> = None;
        for connection in &self.document.connections {
            let (Some(from), Some(to)) = (
                self.document.find_card(&connection.from_id),
                self.document.find_card(&connection.to_id),
            ) else {
                continue;
            };
            let curve = connection_route(&from.world_bounds(), &to.world_bounds());
            let mut previous = self.camera.world_to_screen(curve[0]);
            for i in 1..=CONNECTION_CURVE_SEGMENTS {
                let point = self
                    .camera
                    .world_to_screen(cubic_point(&curve, i as f32 / CONNECTION_CURVE_SEGMENTS as f32));
                let distance = distance_to_segment(screen_pos, previous, point);
                if distance <= CONNECTION_HIT_TOLERANCE_PX && best.map_or(true, |(d, _)| distance < d) {
                    best = Some((distance, connection));
                }
                previous = point;
            }
        }
        best.map(|(_, connection)| connection.clone())
    }

    /// Cards the graph accepts as targets of a connection from `from_id`, in
    /// document order: no self-connection, duplicate or cycle.
    pub fn connection_targets(&self, from_id: &str) -> Vec<String> {
        self.document
            .cards
            .iter()
            .filter(|card| self.document.can_connect(from_id, &card.id).is_ok())
            .map(|card| card.id.clone())
            .collect()
    }

    /// The connection being dragged, in world space, for the renderer. It leaves
    /// the source by the side facing the pointer; over a valid target it snaps to
    /// the connection it would make.
    pub fn connection_preview(&self) -> Option<ConnectionPreview> {
        let InteractionState::Connecting {
            from_id,
            pointer_world,
            target_id,
            valid_target_ids,
            left_source,
        } = &self.interaction
        else {
            return None;
        };
        let source = self.document.find_card(from_id)?.world_bounds();
        let target = target_id
            .as_ref()
            .filter(|id| *left_source || *id != from_id)
            .and_then(|id| self.document.find_card(id));
        let (curve, target_valid) = match target {
            Some(card) if valid_target_ids.contains(&card.id) => {
                (connection_route(&source, &card.world_bounds()), Some(true))
            }
            Some(_) => (connection_route_to_point(&source, *pointer_world), Some(false)),
            None => (connection_route_to_point(&source, *pointer_world), None),
        };
        Some(ConnectionPreview { curve, target_valid })
    }

    /// Selects one connection (or none) and emits the change.
    fn set_connection_selection(&mut self, connection: Option<PrerequisiteConnection>, events: &mut Vec<EditorEvent>) {
        if self.selected_connection != connection {
            self.selected_connection = connection.clone();
            events.push(EditorEvent::ConnectionSelected { connection });
        }
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
            InteractionState::Connecting { from_id, .. } => {
                events.push(EditorEvent::ConnectionDragEnded { from_id, dropped_on: None });
                false
            }
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

    /// Moves cards to new positions and returns the moves that changed a position.
    fn move_cards(&mut self, targets: Vec<(String, Point)>, events: &mut Vec<EditorEvent>) -> Vec<CardMove> {
        let moves: Vec<CardMove> = targets
            .into_iter()
            .filter_map(|(card_id, to)| {
                let from = self.document.find_card(&card_id)?.position;
                let moved = (to.x - from.x).abs() > 1e-4 || (to.y - from.y).abs() > 1e-4;
                moved.then_some(CardMove { card_id, from, to })
            })
            .collect();
        self.place_cards(moves.iter().map(|m| (m.card_id.as_str(), m.to)), events);
        moves
    }

    /// The selected cards' world bounds, in document order.
    fn selected_bounds(&self) -> Vec<(String, Rect)> {
        self.cards_with_selection()
            .filter(|(_, selected)| *selected)
            .map(|(card, _)| (card.id.clone(), card.world_bounds()))
            .collect()
    }

    /// Moves the selection by one step, limited so every card stays within the
    /// world bounds. A step of the same cards right after another joins its undo
    /// step, however many other commands (saves, camera moves) came between.
    fn nudge_selection(&mut self, delta: Point, events: &mut Vec<EditorEvent>) -> bool {
        let selected = self.selected_bounds();
        let Some((_, first)) = selected.first() else {
            return false;
        };
        let (mut min, mut max) = (Point::new(first.x, first.y), Point::new(first.x, first.y));
        for (_, rect) in &selected {
            min = Point::new(min.x.min(rect.x), min.y.min(rect.y));
            max = Point::new(max.x.max(rect.x), max.y.max(rect.y));
        }
        let dx = delta.x.min(MAX_WORLD_COORD - max.x).max(MIN_WORLD_COORD - min.x);
        let dy = delta.y.min(MAX_WORLD_COORD - max.y).max(MIN_WORLD_COORD - min.y);
        let targets = selected
            .into_iter()
            .map(|(id, rect)| (id, Point::new(rect.x + dx, rect.y + dy)))
            .collect();
        let moves = self.move_cards(targets, events);
        if moves.is_empty() {
            return false;
        }
        if self.nudge_depth == Some(self.undo_stack.len()) {
            if let Some(HistoryAction::MoveCards { moves: previous }) = self.undo_stack.last_mut() {
                let same_cards = previous.len() == moves.len()
                    && previous.iter().zip(&moves).all(|(p, m)| p.card_id == m.card_id);
                if same_cards {
                    for (p, m) in previous.iter_mut().zip(moves) {
                        p.to = m.to;
                    }
                    events.push(EditorEvent::HistoryChanged { can_undo: true, can_redo: false });
                    return true;
                }
            }
        }
        self.record(HistoryAction::MoveCards { moves }, events);
        self.nudge_depth = Some(self.undo_stack.len());
        true
    }

    /// Aligns or distributes the selected cards as one undo step. Alignment needs
    /// two cards, distribution three; fewer leave everything in place.
    fn arrange_selection(&mut self, arrangement: Arrangement, events: &mut Vec<EditorEvent>) -> bool {
        let mut selected = self.selected_bounds();
        let distributes = matches!(
            arrangement,
            Arrangement::DistributeHorizontally | Arrangement::DistributeVertically
        );
        if selected.len() < if distributes { 3 } else { 2 } {
            return false;
        }
        let left = selected.iter().map(|(_, r)| r.x).fold(f32::INFINITY, f32::min);
        let top = selected.iter().map(|(_, r)| r.y).fold(f32::INFINITY, f32::min);
        let right = selected.iter().map(|(_, r)| r.x + r.width).fold(f32::NEG_INFINITY, f32::max);
        let bottom = selected.iter().map(|(_, r)| r.y + r.height).fold(f32::NEG_INFINITY, f32::max);
        let targets: Vec<(String, Point)> = match arrangement {
            Arrangement::DistributeHorizontally | Arrangement::DistributeVertically => {
                let horizontal = arrangement == Arrangement::DistributeHorizontally;
                // Ordered by leading edge; a stable sort keeps document order for ties.
                let lead = |r: &Rect| if horizontal { r.x } else { r.y };
                let length = |r: &Rect| if horizontal { r.width } else { r.height };
                selected.sort_by(|(_, a), (_, b)| lead(a).total_cmp(&lead(b)));
                let start = lead(&selected[0].1);
                let last = &selected[selected.len() - 1].1;
                let occupied: f32 = selected.iter().map(|(_, r)| length(r)).sum();
                let gap = (lead(last) + length(last) - start - occupied) / (selected.len() - 1) as f32;
                let mut cursor = start;
                selected
                    .into_iter()
                    .map(|(id, r)| {
                        let at = cursor;
                        cursor += length(&r) + gap;
                        (id, if horizontal { Point::new(at, r.y) } else { Point::new(r.x, at) })
                    })
                    .collect()
            }
            _ => selected
                .into_iter()
                .map(|(id, r)| {
                    let p = match arrangement {
                        Arrangement::AlignLeft => Point::new(left, r.y),
                        Arrangement::AlignCenter => Point::new((left + right - r.width) * 0.5, r.y),
                        Arrangement::AlignRight => Point::new(right - r.width, r.y),
                        Arrangement::AlignTop => Point::new(r.x, top),
                        Arrangement::AlignMiddle => Point::new(r.x, (top + bottom - r.height) * 0.5),
                        Arrangement::AlignBottom => Point::new(r.x, bottom - r.height),
                        Arrangement::DistributeHorizontally | Arrangement::DistributeVertically => unreachable!(),
                    };
                    (id, p)
                })
                .collect(),
        };
        let moves = self.move_cards(targets, events);
        if moves.is_empty() {
            return false;
        }
        self.record(HistoryAction::MoveCards { moves }, events);
        true
    }

    /// A drag of the whole selection, grabbed at `screen_pt` on `anchor_id`.
    fn drag_selection_from(&self, anchor_id: &str, screen_pt: Point) -> InteractionState {
        let Some(card) = self.document.find_card(anchor_id) else {
            return InteractionState::Idle;
        };
        let world_pointer = self.camera.screen_to_world(screen_pt);
        let grab_offset_world = Point::new(world_pointer.x - card.position.x, world_pointer.y - card.position.y);
        let start_positions = self
            .document
            .cards
            .iter()
            .filter(|c| self.selected_card_ids.contains(&c.id))
            .map(|c| (c.id.clone(), c.position))
            .collect();
        InteractionState::DraggingCards {
            anchor_id: anchor_id.to_string(),
            grab_offset_world,
            start_positions,
        }
    }

    /// Records a completed edit as one undo step; a new edit ends the redo history.
    fn record(&mut self, action: HistoryAction, events: &mut Vec<EditorEvent>) {
        self.nudge_depth = None;
        self.undo_stack.push(action);
        self.redo_stack.clear();
        events.push(EditorEvent::HistoryChanged {
            can_undo: true,
            can_redo: false,
        });
    }

    /// Removes a card with every connection that names it; returns them with the
    /// card's place in the document, so an undo can put all of it back.
    fn delete_card(
        &mut self,
        id: &str,
        events: &mut Vec<EditorEvent>,
    ) -> Option<(SkillCard, usize, Vec<PrerequisiteConnection>)> {
        let index = self.document.cards.iter().position(|c| c.id == id)?;
        let card = self.document.cards.remove(index);
        let (taken, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.document.connections)
            .into_iter()
            .partition(|c| c.from_id == id || c.to_id == id);
        self.document.connections = kept;
        events.push(EditorEvent::CardDeleted { card_id: card.id.clone() });
        events.push(EditorEvent::ConnectionsUpdated {
            connections: self.document.connections.clone(),
        });
        let change = self.set_selection(self.selected_card_ids.clone());
        Self::push_selection_change(change, events);
        Some((card, index, taken))
    }

    /// Puts a deleted card back at its place with the connections it took along.
    /// Each connection is validated again; one that no longer fits is left out.
    fn restore_card(
        &mut self,
        card: &SkillCard,
        index: usize,
        connections: &[PrerequisiteConnection],
        events: &mut Vec<EditorEvent>,
    ) -> bool {
        if self.document.find_card(&card.id).is_some() {
            return false;
        }
        let index = index.min(self.document.cards.len());
        self.document.cards.insert(index, card.clone());
        for connection in connections {
            let _ = self.document.try_add_connection(&connection.from_id, &connection.to_id);
        }
        events.push(EditorEvent::CardRestored { card_id: card.id.clone() });
        events.push(EditorEvent::ConnectionsUpdated {
            connections: self.document.connections.clone(),
        });
        true
    }

    /// Adds or removes one connection for an undo or redo; returns whether it changed.
    fn set_connection(&mut self, connection: &PrerequisiteConnection, present: bool, events: &mut Vec<EditorEvent>) -> bool {
        let changed = if present {
            self.document.try_add_connection(&connection.from_id, &connection.to_id).is_ok()
        } else {
            self.document.remove_connection(&connection.from_id, &connection.to_id)
        };
        if changed {
            events.push(EditorEvent::ConnectionsUpdated {
                connections: self.document.connections.clone(),
            });
        }
        changed
    }

    /// Undoes (`forward` false) or redoes one history action; returns whether labels changed.
    fn apply_history(&mut self, action: &HistoryAction, forward: bool, events: &mut Vec<EditorEvent>) -> bool {
        match action {
            HistoryAction::MoveCards { moves } => self.place_cards(
                moves.iter().map(|m| (m.card_id.as_str(), if forward { m.to } else { m.from })),
                events,
            ),
            HistoryAction::DeleteCard { card, index, connections } => {
                if forward {
                    self.delete_card(&card.id, events).is_some()
                } else {
                    self.restore_card(card, *index, connections, events)
                }
            }
            HistoryAction::AddConnection { connection } => {
                self.set_connection(connection, forward, events);
                false
            }
            HistoryAction::RemoveConnection { connection } => {
                self.set_connection(connection, !forward, events);
                false
            }
        }
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
                self.nudge_depth = None;
                self.undo_stack.clear();
                self.redo_stack.clear();
                if let InteractionState::Connecting { from_id, .. } = &self.interaction {
                    events.push(EditorEvent::ConnectionDragEnded { from_id: from_id.clone(), dropped_on: None });
                }
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
                if id.is_some() {
                    self.set_connection_selection(None, &mut events);
                }
                let change = self.select_card(id);
                if Self::push_selection_change(change, &mut events) {
                    labels_changed = true;
                }
            }
            EditorCommand::SelectConnection { connection } => {
                let connection = connection.filter(|c| self.document.has_connection(&c.from_id, &c.to_id));
                if connection.is_some() {
                    let change = self.select_card(None);
                    if Self::push_selection_change(change, &mut events) {
                        labels_changed = true;
                    }
                }
                self.set_connection_selection(connection, &mut events);
            }
            EditorCommand::CancelInteraction => {
                if self.cancel_active_interaction(&mut events) {
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
                let connection_from = if self.edits_content() && !shift_key {
                    self.hit_connection_point(screen_pt)
                } else {
                    None
                };
                if let Some(from_id) = connection_from {
                    // The connection point, not the card body: a connection drag, not a move.
                    self.set_connection_selection(None, &mut events);
                    let valid_target_ids = self.connection_targets(&from_id);
                    events.push(EditorEvent::ConnectionDragStarted {
                        from_id: from_id.clone(),
                        valid_target_ids: valid_target_ids.clone(),
                    });
                    self.interaction = InteractionState::Connecting {
                        target_id: Some(from_id.clone()),
                        from_id,
                        pointer_world: self.camera.screen_to_world(screen_pt),
                        valid_target_ids,
                        left_source: false,
                    };
                } else if let Some(card_id) = hit.clone().filter(|_| shift_key && !self.read_only) {
                    // Shift on a card adds it to the selection or takes it out; a card
                    // it adds drags the selection along, as an ordinary press would.
                    self.set_connection_selection(None, &mut events);
                    let mut ids = self.selected_card_ids.clone();
                    let added = !ids.contains(&card_id);
                    if added {
                        ids.push(card_id.clone());
                    } else {
                        ids.retain(|id| *id != card_id);
                    }
                    let change = self.set_selection(ids);
                    if Self::push_selection_change(change, &mut events) {
                        labels_changed = true;
                    }
                    if added {
                        self.interaction = self.drag_selection_from(&card_id, screen_pt);
                    }
                } else if let Some(card_id) = hit {
                    self.set_connection_selection(None, &mut events);
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
                    } else {
                        self.interaction = self.drag_selection_from(&card_id, screen_pt);
                    }
                } else if shift_key && !self.read_only {
                    // Shift on the empty canvas draws a selection box instead of panning.
                    self.set_connection_selection(None, &mut events);
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
                    // A press on a connection selects it; dragging from there still pans.
                    let connection = self.hit_connection(screen_pt);
                    let change = self.select_card(None);
                    if Self::push_selection_change(change, &mut events) {
                        labels_changed = true;
                    }
                    self.set_connection_selection(connection, &mut events);
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
                    InteractionState::Connecting {
                        from_id,
                        target_id,
                        valid_target_ids,
                        left_source,
                        ..
                    } => {
                        let pointer_world = self.camera.screen_to_world(screen_pt);
                        let hit = self.hit_test(screen_pt);
                        let left_source = left_source || hit.as_deref() != Some(from_id.as_str());
                        if hit != target_id {
                            events.push(EditorEvent::ConnectionDragTargetChanged { target_id: hit.clone() });
                        }
                        self.interaction = InteractionState::Connecting {
                            from_id,
                            pointer_world,
                            target_id: hit,
                            valid_target_ids,
                            left_source,
                        };
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
                            self.record(HistoryAction::MoveCards { moves }, &mut events);
                        }
                    }
                    InteractionState::SelectingBox { origin_world, .. } => {
                        let current_world = self.camera.screen_to_world(screen_pt);
                        let change = self.set_selection(self.cards_in_box(origin_world, current_world));
                        if Self::push_selection_change(change, &mut events) {
                            labels_changed = true;
                        }
                    }
                    InteractionState::Connecting { from_id, left_source, .. } => {
                        // Releasing on the source before leaving it is a click on its
                        // connection point; after leaving, it is a self-connection attempt.
                        let dropped_on = self
                            .hit_test(screen_pt)
                            .filter(|id| left_source || *id != from_id);
                        events.push(EditorEvent::ConnectionDragEnded { from_id, dropped_on });
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
            EditorCommand::SelectAll => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                self.set_connection_selection(None, &mut events);
                let all = self.document.cards.iter().map(|card| card.id.clone()).collect();
                let change = self.set_selection(all);
                if Self::push_selection_change(change, &mut events) {
                    labels_changed = true;
                }
            }
            EditorCommand::NudgeSelection { delta_x, delta_y } => {
                // A step during a gesture would fight the pointer for the cards.
                if self.interaction == InteractionState::Idle {
                    if self.nudge_selection(Point::new(delta_x, delta_y), &mut events) {
                        labels_changed = true;
                    }
                }
            }
            EditorCommand::ArrangeSelection { arrangement } => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                if self.arrange_selection(arrangement, &mut events) {
                    labels_changed = true;
                }
            }
            EditorCommand::Undo => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                self.nudge_depth = None;
                if let Some(action) = self.undo_stack.pop() {
                    if self.apply_history(&action, false, &mut events) {
                        labels_changed = true;
                    }
                    self.redo_stack.push(action);
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
                self.nudge_depth = None;
                if let Some(action) = self.redo_stack.pop() {
                    if self.apply_history(&action, true, &mut events) {
                        labels_changed = true;
                    }
                    self.undo_stack.push(action);
                    events.push(EditorEvent::HistoryChanged {
                        can_undo: true,
                        can_redo: !self.redo_stack.is_empty(),
                    });
                }
            }
            EditorCommand::DeleteCard { id } => {
                if self.cancel_active_interaction(&mut events) {
                    labels_changed = true;
                }
                match self.delete_card(&id, &mut events) {
                    Some((card, index, connections)) => {
                        labels_changed = true;
                        self.record(HistoryAction::DeleteCard { card, index, connections }, &mut events);
                    }
                    None => events.push(EditorEvent::Error {
                        message: format!("Skill card '{}' does not exist", id),
                    }),
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
                        let connection = PrerequisiteConnection::new(from_id.clone(), to_id.clone());
                        self.record(HistoryAction::AddConnection { connection }, &mut events);
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
                    let connection = PrerequisiteConnection::new(from_id, to_id);
                    self.record(HistoryAction::RemoveConnection { connection }, &mut events);
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
                // A connection drag in progress would otherwise propose a connection after the switch.
                if layout_only && matches!(self.interaction, InteractionState::Connecting { .. }) {
                    self.cancel_active_interaction(&mut events);
                }
                self.layout_only = layout_only;
            }
        }

        // A deleted, undone or replaced connection cannot stay selected.
        if let Some(selected) = &self.selected_connection {
            if !self.document.has_connection(&selected.from_id, &selected.to_id) {
                self.set_connection_selection(None, &mut events);
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
