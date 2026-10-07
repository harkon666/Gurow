use crate::geometry::{Camera, Point, Rect, Size, MAX_WORLD_COORD, MAX_ZOOM, MIN_WORLD_COORD, MIN_ZOOM};
use crate::protocol::{EditorCommand, EditorEvent};
use crate::state::{EditorState, InteractionState};
use crate::SkillCard;

#[test]
fn test_camera_world_screen_round_trip() {
    let camera = Camera::new(50.0, -30.0, 1.5);
    let world_p = Point::new(120.0, 240.0);
    let screen_p = camera.world_to_screen(world_p);
    let back_to_world = camera.screen_to_world(screen_p);

    assert!((world_p.x - back_to_world.x).abs() < 1e-5);
    assert!((world_p.y - back_to_world.y).abs() < 1e-5);
}

#[test]
fn test_cursor_anchored_zoom() {
    let mut camera = Camera::new(100.0, 80.0, 1.0);
    let cursor_screen = Point::new(250.0, 180.0);
    let world_before = camera.screen_to_world(cursor_screen);

    // Zoom in by 1.5x
    camera.zoom_at(cursor_screen, 1.5);
    assert!((camera.zoom - 1.5).abs() < 1e-5);

    // World coordinate under cursor must be identical
    let world_after = camera.screen_to_world(cursor_screen);
    assert!((world_before.x - world_after.x).abs() < 1e-4);
    assert!((world_before.y - world_after.y).abs() < 1e-4);

    // Zoom out by 0.5x (relative)
    camera.zoom_at(cursor_screen, 0.5);
    assert!((camera.zoom - 0.75).abs() < 1e-5);
    let world_after_zoom_out = camera.screen_to_world(cursor_screen);
    assert!((world_before.x - world_after_zoom_out.x).abs() < 1e-4);
    assert!((world_before.y - world_after_zoom_out.y).abs() < 1e-4);
}

#[test]
fn test_camera_zoom_limits() {
    let mut camera = Camera::new(0.0, 0.0, 1.0);
    let cursor = Point::new(400.0, 300.0);

    // Try zooming way out below 0.10 (10%)
    camera.zoom_at(cursor, 0.01);
    assert_eq!(camera.zoom, 0.1);

    // Try zooming way in above 4.00 (400%)
    camera.zoom_at(cursor, 100.0);
    assert_eq!(camera.zoom, 4.0);
}

#[test]
fn test_camera_world_bounds_clamping() {
    let mut camera = Camera::new(0.0, 0.0, 1.0);
    // Pan way beyond positive max bounds
    camera.pan(-5_000_000.0, -5_000_000.0);
    let world_origin = camera.screen_to_world(Point::ZERO);
    assert!(world_origin.x <= 1_000_000.0);
    assert!(world_origin.y <= 1_000_000.0);

    // Pan way beyond negative min bounds
    camera.pan(10_000_000.0, 10_000_000.0);
    let world_origin_neg = camera.screen_to_world(Point::ZERO);
    assert!(world_origin_neg.x >= -1_000_000.0);
    assert!(world_origin_neg.y >= -1_000_000.0);
}

#[test]
fn test_create_card_and_prevent_duplicate_id() {
    let mut state = EditorState::new();

    let events = state.apply_command(EditorCommand::CreateCard {
        id: "skill-1".into(),
        title: "Rust Core".into(),
        position: Point::new(100.0, 150.0),
        size: None,
    });

    assert_eq!(state.document.cards.len(), 1);
    assert!(events
        .iter()
        .any(|e| matches!(e, EditorEvent::CardCreated { .. })));

    // Try creating with the same id
    let dup_events = state.apply_command(EditorCommand::CreateCard {
        id: "skill-1".into(),
        title: "Another Rust".into(),
        position: Point::new(200.0, 200.0),
        size: None,
    });

    assert_eq!(state.document.cards.len(), 1);
    assert!(dup_events
        .iter()
        .any(|e| matches!(e, EditorEvent::Error { .. })));
}

#[test]
fn test_hit_testing_and_selection_with_title() {
    let mut state = EditorState::new();
    state.camera = Camera::new(0.0, 0.0, 1.0);

    state.apply_command(EditorCommand::CreateCard {
        id: "card-a".into(),
        title: "Card A".into(),
        position: Point::new(50.0, 50.0),
        size: Some(Size::new(100.0, 60.0)),
    });

    // Hit inside card A
    let hit = state.hit_test(Point::new(80.0, 80.0));
    assert_eq!(hit.as_deref(), Some("card-a"));

    // Hit outside card A
    let miss = state.hit_test(Point::new(20.0, 20.0));
    assert_eq!(miss, None);

    // PointerDown inside card A
    let events = state.apply_command(EditorCommand::PointerDown {
        screen_x: 70.0,
        screen_y: 70.0, shift_key: false
    });
    assert_eq!(state.selected_card_id(), Some("card-a"));
    assert!(events.iter().any(|e| matches!(
        e,
        EditorEvent::SelectionChanged {
            selected_id: Some(id),
            title: Some(t),
        ..
        } if id == "card-a" && t == "Card A"
    )));

    // PointerDown outside -> deselects
    let deselect_events = state.apply_command(EditorCommand::PointerDown {
        screen_x: 300.0,
        screen_y: 300.0, shift_key: false
    });
    assert_eq!(state.selected_card_id(), None);
    assert!(deselect_events.iter().any(|e| matches!(
        e,
        EditorEvent::SelectionChanged {
            selected_id: None,
            title: None,
        ..
        }
    )));
}

#[test]
fn test_label_layouts_are_world_space_and_camera_independent() {
    let mut state = EditorState::new();
    state.camera = Camera::new(100.0, 50.0, 2.0); // 2x zoom, offset (100, 50)

    state.apply_command(EditorCommand::CreateCard {
        id: "card-1".into(),
        title: "WebGPU Pipeline".into(),
        position: Point::new(10.0, 20.0),
        size: Some(Size::new(100.0, 50.0)),
    });

    let labels = state.get_label_layouts();
    assert_eq!(labels.len(), 1);
    let label = &labels[0];
    assert_eq!(label.card_id, "card-1");
    assert_eq!(label.title, "WebGPU Pipeline");
    // The overlay applies the camera as one transform; labels carry world bounds.
    assert_eq!(label.world_rect, Rect::new(10.0, 20.0, 100.0, 50.0));
    assert_eq!(label.selected, false);

    state.apply_command(EditorCommand::SelectCard {
        id: Some("card-1".into()),
    });
    let updated_labels = state.get_label_layouts();
    assert_eq!(updated_labels[0].selected, true);
}

#[test]
fn test_json_protocol_roundtrip() {
    let commands = vec![
        EditorCommand::LoadDocument {
            document: crate::document::CanvasDocument::new(),
        },
        EditorCommand::CreateCard {
            id: "skill-async".into(),
            title: "Async Rust".into(),
            position: Point::new(100.0, 200.0),
            size: Some(Size::new(180.0, 80.0)),
        },
        EditorCommand::CreateCard {
            id: "skill-no-size".into(),
            title: "Default Size Card".into(),
            position: Point::new(10.0, 20.0),
            size: None,
        },
        EditorCommand::SelectCard {
            id: Some("skill-async".into()),
        },
        EditorCommand::SelectCard { id: None },
        EditorCommand::PointerDown {
            screen_x: 150.0,
            screen_y: 250.0, shift_key: false
        },
        EditorCommand::PointerMove {
            screen_x: 160.0,
            screen_y: 260.0,
        },
        EditorCommand::PointerUp {
            screen_x: 160.0,
            screen_y: 260.0,
        },
        EditorCommand::PanCamera {
            delta_x: 30.0,
            delta_y: -15.0,
        },
        EditorCommand::ZoomAt {
            screen_x: 400.0,
            screen_y: 300.0,
            factor: 1.2,
        },
        EditorCommand::Undo,
        EditorCommand::Redo,
        EditorCommand::ResizeViewport {
            width: 1280.0,
            height: 720.0,
        },
    ];

    for cmd in commands {
        let json = serde_json::to_string(&cmd).expect("serialize command");
        let deserialized: EditorCommand = serde_json::from_str(&json).expect("deserialize command");
        assert_eq!(cmd, deserialized);
    }

    let events = vec![
        EditorEvent::DocumentLoaded,
        EditorEvent::CardCreated {
            card: crate::document::SkillCard::new(
                "card-1",
                "Title 1",
                Point::new(10.0, 20.0),
                Some(Size::new(180.0, 80.0)),
            ),
        },
        EditorEvent::CardMoved {
            card_id: "card-1".into(),
            position: Point::new(30.0, 40.0),
        },
        EditorEvent::SelectionChanged {
            selected_id: Some("card-1".into()),
            title: Some("Title 1".into()),
            selected_ids: vec!["card-1".into()],
        },
        EditorEvent::SelectionChanged {
            selected_id: None,
            title: None,
            selected_ids: vec!["card-1".into(), "card-2".into()],
        },
        EditorEvent::LabelsUpdated {
            labels: vec![crate::protocol::LabelLayout {
                card_id: "card-1".into(),
                title: "Title 1".into(),
                world_rect: Rect::new(10.0, 20.0, 180.0, 80.0),
                selected: true,
            }],
        },
        EditorEvent::CameraChanged {
            offset_x: 100.0,
            offset_y: 50.0,
            zoom: 1.2,
        },
        EditorEvent::HistoryChanged {
            can_undo: true,
            can_redo: false,
        },
        EditorEvent::GpuError {
            message: "Surface lost".into(),
        },
        EditorEvent::Error {
            message: "Test error".into(),
        },
    ];

    for event in events {
        let json = serde_json::to_string(&event).expect("serialize event");
        let deserialized: EditorEvent = serde_json::from_str(&json).expect("deserialize event");
        assert_eq!(event, deserialized);
    }
}

#[test]
fn test_cards_with_selection_and_select_card_struct() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "c1".into(),
        title: "Card 1".into(),
        position: Point::new(10.0, 10.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "c2".into(),
        title: "Card 2".into(),
        position: Point::new(200.0, 10.0),
        size: None,
    });

    let change = state.select_card(Some("c1".into())).expect("selection change");
    assert_eq!(change.selected_id.as_deref(), Some("c1"));
    assert_eq!(change.title.as_deref(), Some("Card 1"));

    let items: Vec<(String, bool)> = state
        .cards_with_selection()
        .map(|(c, sel)| (c.id.clone(), sel))
        .collect();
    assert_eq!(items, vec![("c1".to_string(), true), ("c2".to_string(), false)]);

}

#[test]
fn test_deserialize_card_with_default_size() {
    let json = r#"{"cards":[{"id":"skill-1","title":"Skill 1","position":{"x":10.0,"y":20.0}}]}"#;
    let doc: crate::document::CanvasDocument = serde_json::from_str(json).expect("deserialize doc");
    assert_eq!(doc.cards.len(), 1);
    assert_eq!(doc.cards[0].size, Size::new(180.0, 80.0));
}

#[test]
fn test_card_drag_preserves_offset_across_zoom_levels() {
    // Test at zoom 1.0, 0.5, and 2.0
    for zoom in [1.0, 0.5, 2.0] {
        let mut state = EditorState::new();
        state.camera = Camera::new(50.0, 50.0, zoom);
        state.apply_command(EditorCommand::CreateCard {
            id: "card-drag".into(),
            title: "Drag Card".into(),
            position: Point::new(100.0, 100.0),
            size: Some(Size::new(180.0, 80.0)),
        });

        // PointerDown on the card at relative world offset (20.0, 30.0)
        let world_pointer = Point::new(120.0, 130.0);
        let screen_pointer = state.camera.world_to_screen(world_pointer);
        state.apply_command(EditorCommand::PointerDown {
            screen_x: screen_pointer.x,
            screen_y: screen_pointer.y, shift_key: false
        });

        // PointerMove to new screen coordinate corresponding to target world pointer (220.0, 230.0)
        let new_world_pointer = Point::new(220.0, 230.0);
        let new_screen_pointer = state.camera.world_to_screen(new_world_pointer);
        let events = state.apply_command(EditorCommand::PointerMove {
            screen_x: new_screen_pointer.x,
            screen_y: new_screen_pointer.y,
        });

        // Card world position must be (220.0 - 20.0, 230.0 - 30.0) = (200.0, 200.0)
        let card = state.document.find_card("card-drag").unwrap();
        assert!((card.position.x - 200.0).abs() < 1e-4, "failed at zoom {}", zoom);
        assert!((card.position.y - 200.0).abs() < 1e-4, "failed at zoom {}", zoom);

        // CardMoved and LabelsUpdated events must have been emitted
        assert!(events.iter().any(|e| matches!(e, EditorEvent::CardMoved { card_id, position } if card_id == "card-drag" && (position.x - 200.0).abs() < 1e-4)));
        assert!(events.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })));

        state.apply_command(EditorCommand::PointerUp {
            screen_x: new_screen_pointer.x,
            screen_y: new_screen_pointer.y,
        });
    }
}

#[test]
fn test_drag_undo_redo_invariants() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "card-u".into(),
        title: "Undo Card".into(),
        position: Point::new(100.0, 100.0),
        size: Some(Size::new(180.0, 80.0)),
    });

    // 1. Stationary click does NOT create an undo step
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0, shift_key: false });
    let up_events = state.apply_command(EditorCommand::PointerUp { screen_x: 120.0, screen_y: 120.0 });
    assert_eq!(state.undo_stack.len(), 0);
    assert!(!up_events.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { .. })));

    // 2. Dragging card creates exactly one undo step on PointerUp
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 220.0, screen_y: 220.0 });
    state.apply_command(EditorCommand::PointerMove { screen_x: 320.0, screen_y: 320.0 });
    let up_events = state.apply_command(EditorCommand::PointerUp { screen_x: 320.0, screen_y: 320.0 });

    assert_eq!(state.undo_stack.len(), 1);
    assert_eq!(state.redo_stack.len(), 0);
    assert!(up_events.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })));

    let moved_card = state.document.find_card("card-u").unwrap();
    assert!((moved_card.position.x - 300.0).abs() < 1e-4);
    assert!((moved_card.position.y - 300.0).abs() < 1e-4);

    // 3. Undo restores starting position and updates labels + history
    let undo_events = state.apply_command(EditorCommand::Undo);
    assert_eq!(state.undo_stack.len(), 0);
    assert_eq!(state.redo_stack.len(), 1);
    let reverted_card = state.document.find_card("card-u").unwrap();
    assert_eq!(reverted_card.position, Point::new(100.0, 100.0));
    assert!(undo_events.iter().any(|e| matches!(e, EditorEvent::CardMoved { card_id, position } if card_id == "card-u" && *position == Point::new(100.0, 100.0))));
    assert!(undo_events.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: false, can_redo: true })));
    assert!(undo_events.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })));

    // 4. Redo restores final dragged position
    let redo_events = state.apply_command(EditorCommand::Redo);
    assert_eq!(state.undo_stack.len(), 1);
    assert_eq!(state.redo_stack.len(), 0);
    let redone_card = state.document.find_card("card-u").unwrap();
    assert!((redone_card.position.x - 300.0).abs() < 1e-4);
    assert!((redone_card.position.y - 300.0).abs() < 1e-4);
    assert!(redo_events.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })));

    // 5. Redundant undo/redo when stack is empty does not panic or corrupt state
    state.apply_command(EditorCommand::Undo);
    let noop_events = state.apply_command(EditorCommand::Undo);
    assert_eq!(noop_events.len(), 0);
}

#[test]
fn test_canvas_pan_and_zoom_commands() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "card-fixed".into(),
        title: "Fixed Card".into(),
        position: Point::new(100.0, 100.0),
        size: None,
    });

    // Drag on empty canvas space pans camera
    state.apply_command(EditorCommand::PointerDown { screen_x: 10.0, screen_y: 10.0, shift_key: false });
    let pan_events = state.apply_command(EditorCommand::PointerMove { screen_x: 60.0, screen_y: 40.0 });
    assert_eq!(state.camera.offset_x, 50.0);
    assert_eq!(state.camera.offset_y, 30.0);
    assert!(pan_events.iter().any(|e| matches!(e, EditorEvent::CameraChanged { offset_x, offset_y, .. } if (*offset_x - 50.0).abs() < 1e-4 && (*offset_y - 30.0).abs() < 1e-4)));

    // PanCamera command directly updates camera
    state.apply_command(EditorCommand::PanCamera { delta_x: -20.0, delta_y: 10.0 });
    assert_eq!(state.camera.offset_x, 30.0);
    assert_eq!(state.camera.offset_y, 40.0);

    // ZoomAt command applies cursor-anchored zoom
    let zoom_events = state.apply_command(EditorCommand::ZoomAt {
        screen_x: 200.0,
        screen_y: 200.0,
        factor: 2.0,
    });
    assert_eq!(state.camera.zoom, 2.0);
    assert!(zoom_events.iter().any(|e| matches!(e, EditorEvent::CameraChanged { zoom, .. } if (*zoom - 2.0).abs() < 1e-4)));
    assert!(!zoom_events.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })));
}

#[test]
fn test_camera_only_commands_move_labels_through_camera_changed() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "card-a".into(),
        title: "A".into(),
        position: Point::new(100.0, 100.0),
        size: None,
    });
    let labels_before = state.get_label_layouts();
    let camera_commands = vec![
        EditorCommand::PanCamera { delta_x: 15.0, delta_y: -5.0 },
        EditorCommand::ZoomAt { screen_x: 50.0, screen_y: 60.0, factor: 1.5 },
        EditorCommand::SetCamera { offset_x: 3.0, offset_y: 4.0, zoom: 0.5 },
        EditorCommand::PointerDown { screen_x: 500.0, screen_y: 500.0, shift_key: false },
        EditorCommand::PointerMove { screen_x: 520.0, screen_y: 530.0 },
        EditorCommand::PointerUp { screen_x: 520.0, screen_y: 530.0 },
        EditorCommand::ResizeViewport { width: 640.0, height: 480.0 },
    ];
    for cmd in camera_commands {
        let moves_camera = matches!(cmd, EditorCommand::PanCamera { .. } | EditorCommand::ZoomAt { .. } | EditorCommand::SetCamera { .. } | EditorCommand::PointerMove { .. });
        let events = state.apply_command(cmd);
        assert!(!events.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })), "camera-only command re-sent labels: {events:?}");
        assert_eq!(moves_camera, events.iter().any(|e| matches!(e, EditorEvent::CameraChanged { .. })), "{events:?}");
    }
    assert_eq!(state.get_label_layouts(), labels_before);

    // Moving a card still re-sends its world bounds.
    let start = state.camera.world_to_screen(Point::new(110.0, 110.0));
    state.apply_command(EditorCommand::PointerDown { screen_x: start.x, screen_y: start.y, shift_key: false });
    let drag = state.apply_command(EditorCommand::PointerMove { screen_x: start.x + 10.0, screen_y: start.y });
    let labels = drag.iter().find_map(|e| match e { EditorEvent::LabelsUpdated { labels } => Some(labels.clone()), _ => None }).expect("drag re-sends labels");
    assert!((labels[0].world_rect.x - (100.0 + 10.0 / state.camera.zoom)).abs() < 1e-3);
}

#[test]
fn test_undo_during_active_drag_preserves_history() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "card-drag-bug".into(),
        title: "Drag Bug Card".into(),
        position: Point::new(100.0, 100.0),
        size: Some(Size::new(180.0, 80.0)),
    });

    // Drag 1: Move from 100 to 200 (completed)
    state.apply_command(EditorCommand::PointerDown { screen_x: 100.0, screen_y: 100.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 200.0, screen_y: 200.0 });
    state.apply_command(EditorCommand::PointerUp { screen_x: 200.0, screen_y: 200.0 });

    let card = state.document.find_card("card-drag-bug").unwrap();
    assert_eq!(card.position, Point::new(200.0, 200.0));
    assert_eq!(state.undo_stack.len(), 1);

    // Drag 2 (interrupted): Start dragging towards 300
    state.apply_command(EditorCommand::PointerDown { screen_x: 200.0, screen_y: 200.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 250.0, screen_y: 250.0 });
    assert!(matches!(state.interaction, InteractionState::DraggingCards { .. }));

    // User presses Ctrl+Z (Undo) before releasing pointer
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.interaction, InteractionState::Idle);
    let card_after_undo = state.document.find_card("card-drag-bug").unwrap();
    assert_eq!(card_after_undo.position, Point::new(100.0, 100.0));

    // User now releases pointer at 300.0
    state.apply_command(EditorCommand::PointerUp { screen_x: 300.0, screen_y: 300.0 });
    let card_after_up = state.document.find_card("card-drag-bug").unwrap();
    assert_eq!(card_after_up.position, Point::new(100.0, 100.0));

    // Undo until empty: card remains at 100
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.document.find_card("card-drag-bug").unwrap().position, Point::new(100.0, 100.0));

    // Redo restores position 200
    state.apply_command(EditorCommand::Redo);
    assert_eq!(state.document.find_card("card-drag-bug").unwrap().position, Point::new(200.0, 200.0));

    // Undo again restores initial position 100
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.document.find_card("card-drag-bug").unwrap().position, Point::new(100.0, 100.0));
}

#[test]
fn test_connect_skills_valid_and_branching() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-a".into(),
        title: "Skill A".into(),
        position: Point::new(0.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-b".into(),
        title: "Skill B".into(),
        position: Point::new(200.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-c".into(),
        title: "Skill C".into(),
        position: Point::new(400.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-d".into(),
        title: "Skill D".into(),
        position: Point::new(200.0, 200.0),
        size: None,
    });

    // 1. Connect A -> B (A is prerequisite for B)
    let events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    });
    assert!(events.iter().any(|e| matches!(
        e,
        EditorEvent::ConnectionCreated { from_id, to_id }
            if from_id == "skill-a" && to_id == "skill-b"
    )));
    assert_eq!(state.document.connections.len(), 1);
    assert!(state.document.has_connection("skill-a", "skill-b"));

    // 2. Convergent Branching: Multiple prerequisites for C (A -> C and B -> C)
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-c".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-b".into(),
        to_id: "skill-c".into(),
    });
    assert_eq!(state.document.connections.len(), 3);

    // 3. Divergent Branching: A feeds both B and D
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-d".into(),
    });
    assert_eq!(state.document.connections.len(), 4);
    assert!(state.document.has_connection("skill-a", "skill-d"));
}

#[test]
fn test_connect_skills_self_cycle_rejected() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-a".into(),
        title: "Skill A".into(),
        position: Point::new(0.0, 0.0),
        size: None,
    });

    // Attempt connecting A -> A
    let events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-a".into(),
    });

    assert_eq!(state.document.connections.len(), 0);
    let rejected = events.iter().find(|e| matches!(e, EditorEvent::ConnectionRejected { .. }));
    assert!(rejected.is_some(), "Expected ConnectionRejected event");
    if let Some(EditorEvent::ConnectionRejected { from_id, to_id, reason }) = rejected {
        assert_eq!(from_id, "skill-a");
        assert_eq!(to_id, "skill-a");
        assert!(reason.contains("self-prerequisite") || reason.contains("cycle"));
    }
}

#[test]
fn test_connect_skills_2_node_cycle_rejected() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-a".into(),
        title: "Skill A".into(),
        position: Point::new(0.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-b".into(),
        title: "Skill B".into(),
        position: Point::new(200.0, 0.0),
        size: None,
    });

    // A -> B succeeds
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    });
    assert_eq!(state.document.connections.len(), 1);

    // Attempt B -> A (creates cycle B -> A -> B)
    let events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-b".into(),
        to_id: "skill-a".into(),
    });

    // Previous graph must be completely preserved!
    assert_eq!(state.document.connections.len(), 1);
    assert!(state.document.has_connection("skill-a", "skill-b"));
    assert!(!state.document.has_connection("skill-b", "skill-a"));

    let rejected = events.iter().find(|e| matches!(e, EditorEvent::ConnectionRejected { .. }));
    assert!(rejected.is_some());
    if let Some(EditorEvent::ConnectionRejected { from_id, to_id, reason }) = rejected {
        assert_eq!(from_id, "skill-b");
        assert_eq!(to_id, "skill-a");
        assert!(reason.contains("cycle"), "Reason must explain cycle: {}", reason);
    }
}

#[test]
fn test_connect_skills_multi_node_cycle_rejected_with_path_explanation() {
    let mut state = EditorState::new();
    for name in &["A", "B", "C", "D"] {
        state.apply_command(EditorCommand::CreateCard {
            id: format!("skill-{}", name.to_lowercase()),
            title: format!("Skill {}", name),
            position: Point::new(0.0, 0.0),
            size: None,
        });
    }

    // A -> B -> C -> D
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-b".into(),
        to_id: "skill-c".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-c".into(),
        to_id: "skill-d".into(),
    });
    assert_eq!(state.document.connections.len(), 3);

    // Attempt D -> A (would create D -> A -> B -> C -> D)
    let events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-d".into(),
        to_id: "skill-a".into(),
    });

    // Unchanged state after cycle-creating edit
    assert_eq!(state.document.connections.len(), 3);
    assert!(!state.document.has_connection("skill-d", "skill-a"));

    let rejected = events.iter().find(|e| matches!(e, EditorEvent::ConnectionRejected { .. }));
    assert!(rejected.is_some());
    if let Some(EditorEvent::ConnectionRejected { reason, .. }) = rejected {
        assert!(reason.contains("cycle"), "Reason should mention cycle: {}", reason);
        assert!(reason.contains("Skill D") && reason.contains("Skill A"));
    }
}

#[test]
fn test_connect_skills_branching_cycle_rejected() {
    let mut state = EditorState::new();
    for name in &["A", "B", "C", "D"] {
        state.apply_command(EditorCommand::CreateCard {
            id: format!("skill-{}", name.to_lowercase()),
            title: format!("Skill {}", name),
            position: Point::new(0.0, 0.0),
            size: None,
        });
    }

    // A -> B -> D
    // A -> C -> D
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-b".into(),
        to_id: "skill-d".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-c".into(),
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-c".into(),
        to_id: "skill-d".into(),
    });
    assert_eq!(state.document.connections.len(), 4);

    // Attempt D -> A (creates cycle through both branches)
    let events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-d".into(),
        to_id: "skill-a".into(),
    });

    assert_eq!(state.document.connections.len(), 4);
    assert!(events.iter().any(|e| matches!(e, EditorEvent::ConnectionRejected { .. })));
}

#[test]
fn test_connect_skills_unknown_card_and_duplicate() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-1".into(),
        title: "Skill 1".into(),
        position: Point::new(0.0, 0.0),
        size: None,
    });

    // Unknown target
    let events1 = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-1".into(),
        to_id: "non-existent".into(),
    });
    assert!(events1.iter().any(|e| matches!(e, EditorEvent::ConnectionRejected { .. })));

    // Unknown source
    let events2 = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "non-existent".into(),
        to_id: "skill-1".into(),
    });
    assert!(events2.iter().any(|e| matches!(e, EditorEvent::ConnectionRejected { .. })));

    // Create skill-2 and connect
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-2".into(),
        title: "Skill 2".into(),
        position: Point::new(100.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-1".into(),
        to_id: "skill-2".into(),
    });
    assert_eq!(state.document.connections.len(), 1);

    // Duplicate connect
    let dup_events = state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-1".into(),
        to_id: "skill-2".into(),
    });
    assert_eq!(state.document.connections.len(), 1);
    assert!(dup_events.iter().any(|e| matches!(e, EditorEvent::ConnectionRejected { .. })));
}

#[test]
fn test_disconnect_skills() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-1".into(),
        title: "Skill 1".into(),
        position: Point::new(0.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::CreateCard {
        id: "skill-2".into(),
        title: "Skill 2".into(),
        position: Point::new(100.0, 0.0),
        size: None,
    });
    state.apply_command(EditorCommand::ConnectSkills {
        from_id: "skill-1".into(),
        to_id: "skill-2".into(),
    });
    assert_eq!(state.document.connections.len(), 1);

    // Disconnect
    let events = state.apply_command(EditorCommand::DisconnectSkills {
        from_id: "skill-1".into(),
        to_id: "skill-2".into(),
    });
    assert_eq!(state.document.connections.len(), 0);
    assert!(events.iter().any(|e| matches!(
        e,
        EditorEvent::ConnectionDeleted { from_id, to_id }
            if from_id == "skill-1" && to_id == "skill-2"
    )));
}

#[test]
fn test_connection_protocol_serialization_roundtrip() {
    let conn_cmd = EditorCommand::ConnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    };
    let json_cmd = serde_json::to_string(&conn_cmd).unwrap();
    let deserialized_cmd: EditorCommand = serde_json::from_str(&json_cmd).unwrap();
    assert_eq!(conn_cmd, deserialized_cmd);

    let disconn_cmd = EditorCommand::DisconnectSkills {
        from_id: "skill-a".into(),
        to_id: "skill-b".into(),
    };
    let json_disconn = serde_json::to_string(&disconn_cmd).unwrap();
    let deserialized_disconn: EditorCommand = serde_json::from_str(&json_disconn).unwrap();
    assert_eq!(disconn_cmd, deserialized_disconn);

    let events = vec![
        EditorEvent::ConnectionCreated {
            from_id: "skill-a".into(),
            to_id: "skill-b".into(),
        },
        EditorEvent::ConnectionDeleted {
            from_id: "skill-a".into(),
            to_id: "skill-b".into(),
        },
        EditorEvent::ConnectionRejected {
            from_id: "skill-b".into(),
            to_id: "skill-a".into(),
            reason: "Cycle detected".into(),
        },
        EditorEvent::ConnectionsUpdated {
            connections: vec![crate::document::PrerequisiteConnection::new("skill-a", "skill-b")],
        },
    ];

    for event in events {
        let json_event = serde_json::to_string(&event).unwrap();
        let deserialized_event: EditorEvent = serde_json::from_str(&json_event).unwrap();
        assert_eq!(event, deserialized_event);
    }
}

#[test]
fn test_canvas_document_encapsulates_connection_invariants() {
    use crate::document::{CanvasDocument, ConnectionError, SkillCard};

    let mut doc = CanvasDocument::new();
    doc.add_card(SkillCard::new("card-1", "Card 1", Point::new(0.0, 0.0), None)).unwrap();
    doc.add_card(SkillCard::new("card-2", "Card 2", Point::new(100.0, 0.0), None)).unwrap();
    doc.add_card(SkillCard::new("card-3", "Card 3", Point::new(200.0, 0.0), None)).unwrap();

    // 1. Valid connection
    assert!(doc.try_add_connection("card-1", "card-2").is_ok());
    assert!(doc.has_connection("card-1", "card-2"));

    // 2. Duplicate connection rejected by document
    assert_eq!(
        doc.try_add_connection("card-1", "card-2"),
        Err(ConnectionError::AlreadyConnected("card-1".into(), "card-2".into()))
    );

    // 3. Self-cycle rejected by document
    assert_eq!(
        doc.try_add_connection("card-1", "card-1"),
        Err(ConnectionError::SelfCycle("card-1".into()))
    );

    // 4. Missing cards rejected by document
    assert_eq!(
        doc.try_add_connection("missing", "card-2"),
        Err(ConnectionError::SourceCardNotFound("missing".into()))
    );
    assert_eq!(
        doc.try_add_connection("card-1", "missing"),
        Err(ConnectionError::TargetCardNotFound("missing".into()))
    );

    // 5. Multi-node cycle rejected by document with path
    assert!(doc.try_add_connection("card-2", "card-3").is_ok());
    let cycle_err = doc.try_add_connection("card-3", "card-1");
    assert!(matches!(cycle_err, Err(ConnectionError::CreatesCycle { ref path }) if path == &vec!["card-1", "card-2", "card-3"]));
}

#[test]
fn test_export_snapshot_and_set_camera() {
    let mut state = EditorState::new();
    let card1 = SkillCard::new("card-1", "Card 1", Point::new(10.0, 20.0), None);
    let card2 = SkillCard::new("card-2", "Card 2", Point::new(100.0, 200.0), None);
    state.document.add_card(card1).unwrap();
    state.document.add_card(card2).unwrap();
    state.document.try_add_connection("card-1", "card-2").unwrap();

    // 1. Export snapshot returns current document
    let events = state.apply_command(EditorCommand::ExportSnapshot);
    assert_eq!(events.len(), 1);
    match &events[0] {
        EditorEvent::SnapshotExported { document } => {
            assert_eq!(document.cards.len(), 2);
            assert_eq!(document.connections.len(), 1);
            assert_eq!(document.cards[0].id, "card-1");
            assert_eq!(document.connections[0].from_id, "card-1");
            assert_eq!(document.connections[0].to_id, "card-2");
        }
        _ => panic!("Expected SnapshotExported event"),
    }

    // 2. Set camera directly restores camera parameters within bounds
    let events = state.apply_command(EditorCommand::SetCamera {
        offset_x: 45.0,
        offset_y: -80.0,
        zoom: 1.5,
    });
    assert!(events.iter().any(|e| matches!(e, EditorEvent::CameraChanged { offset_x, offset_y, zoom } if *offset_x == 45.0 && *offset_y == -80.0 && *zoom == 1.5)));
    assert_eq!(state.camera.offset_x, 45.0);
    assert_eq!(state.camera.offset_y, -80.0);
    assert_eq!(state.camera.zoom, 1.5);

    // 3. Set camera clamps zoom limits
    state.apply_command(EditorCommand::SetCamera {
        offset_x: 0.0,
        offset_y: 0.0,
        zoom: 10.0,
    });
    assert_eq!(state.camera.zoom, crate::geometry::MAX_ZOOM);
}



#[test]
fn test_read_only_canvas_navigates_and_selects_without_changing_the_document() {
    let mut state = EditorState::new();
    for (id, x) in [("card-a", 100.0), ("card-b", 400.0)] {
        state.apply_command(EditorCommand::CreateCard {
            id: id.into(),
            title: id.into(),
            position: Point::new(x, 100.0),
            size: Some(Size::new(180.0, 80.0)),
        });
    }
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    let document = state.document.clone();
    state.apply_command(EditorCommand::LoadDocument { document });
    let events = state.apply_command(EditorCommand::SetReadOnly { read_only: true });
    assert!(events.is_empty());
    let document = state.document.clone();

    // Pressing a card selects it; dragging from it pans the view instead of moving the card.
    let down = state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0, shift_key: false });
    assert!(down.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: Some(id), .. } if id == "card-a")));
    let moved = state.apply_command(EditorCommand::PointerMove { screen_x: 220.0, screen_y: 170.0 });
    let up = state.apply_command(EditorCommand::PointerUp { screen_x: 220.0, screen_y: 170.0 });
    assert!(!moved.iter().chain(up.iter()).any(|e| matches!(e, EditorEvent::CardMoved { .. } | EditorEvent::HistoryChanged { .. })));
    assert!(moved.iter().any(|e| matches!(e, EditorEvent::CameraChanged { offset_x, offset_y, .. } if *offset_x == 100.0 && *offset_y == 50.0)));
    assert_eq!(state.document, document);
    assert!(state.undo_stack.is_empty());
    assert_eq!(state.selected_card_id(), Some("card-a"));

    // Empty canvas still pans and clears the selection; zoom and keyboard selection work.
    state.apply_command(EditorCommand::PointerDown { screen_x: 790.0, screen_y: 590.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 780.0, screen_y: 580.0 });
    state.apply_command(EditorCommand::PointerUp { screen_x: 780.0, screen_y: 580.0 });
    assert_eq!(state.selected_card_id(), None);
    assert_eq!((state.camera.offset_x, state.camera.offset_y), (90.0, 40.0));
    state.apply_command(EditorCommand::ZoomAt { screen_x: 400.0, screen_y: 300.0, factor: 1.5 });
    assert_eq!(state.camera.zoom, 1.5);
    let selected = state.apply_command(EditorCommand::SelectCard { id: Some("card-b".into()) });
    assert!(selected.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: Some(id), .. } if id == "card-b")));

    // Every document edit is refused with a reason and changes nothing.
    let edits = [
        EditorCommand::CreateCard { id: "card-c".into(), title: "C".into(), position: Point::new(0.0, 0.0), size: None },
        EditorCommand::ConnectSkills { from_id: "card-b".into(), to_id: "card-a".into() },
        EditorCommand::DisconnectSkills { from_id: "card-a".into(), to_id: "card-b".into() },
        EditorCommand::Undo,
        EditorCommand::Redo,
    ];
    for edit in edits {
        let events = state.apply_command(edit.clone());
        assert!(
            events.iter().all(|e| matches!(e, EditorEvent::Error { message } if message.contains("read-only"))) && events.len() == 1,
            "{:?} answered {:?}",
            edit,
            events
        );
    }
    assert_eq!(state.document, document);

    // Loading the shared layout still replaces the document; it is not an edit of it.
    let mut layout = document.clone();
    layout.cards[0].position = Point::new(-50.0, 300.0);
    state.apply_command(EditorCommand::LoadDocument { document: layout.clone() });
    assert_eq!(state.document, layout);

    // Leaving read-only restores editing.
    state.apply_command(EditorCommand::SetReadOnly { read_only: false });
    let created = state.apply_command(EditorCommand::CreateCard { id: "card-c".into(), title: "C".into(), position: Point::new(0.0, 0.0), size: None });
    assert!(created.iter().any(|e| matches!(e, EditorEvent::CardCreated { .. })));
}

#[test]
fn test_entering_read_only_cancels_an_active_drag() {
    let mut state = EditorState::new();
    state.apply_command(EditorCommand::CreateCard {
        id: "card-a".into(),
        title: "A".into(),
        position: Point::new(100.0, 100.0),
        size: Some(Size::new(180.0, 80.0)),
    });
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 220.0, screen_y: 220.0 });
    let events = state.apply_command(EditorCommand::SetReadOnly { read_only: true });
    assert!(events.iter().any(|e| matches!(e, EditorEvent::CardMoved { position, .. } if *position == Point::new(100.0, 100.0))));
    assert_eq!(state.interaction, InteractionState::Idle);
    state.apply_command(EditorCommand::PointerUp { screen_x: 220.0, screen_y: 220.0 });
    assert_eq!(state.document.find_card("card-a").unwrap().position, Point::new(100.0, 100.0));
    assert!(state.undo_stack.is_empty());
}

#[test]
fn test_layout_only_canvas_moves_cards_and_undoes_moves_but_keeps_its_content() {
    let mut state = EditorState::new();
    for (id, x) in [("card-a", 100.0), ("card-b", 400.0)] {
        state.apply_command(EditorCommand::CreateCard {
            id: id.into(),
            title: id.into(),
            position: Point::new(x, 100.0),
            size: Some(Size::new(180.0, 80.0)),
        });
    }
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    let events = state.apply_command(EditorCommand::SetLayoutOnly { layout_only: true });
    assert!(events.is_empty());
    let connections = state.document.connections.clone();

    // One drag moves the card and is one undo step.
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 220.0, screen_y: 170.0 });
    let up = state.apply_command(EditorCommand::PointerUp { screen_x: 220.0, screen_y: 170.0 });
    assert!(up.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, .. })));
    assert_eq!(state.document.find_card("card-a").unwrap().position, Point::new(200.0, 150.0));

    // Undo and redo the move: positions only.
    let undone = state.apply_command(EditorCommand::Undo);
    assert!(undone.iter().any(|e| matches!(e, EditorEvent::CardMoved { position, .. } if *position == Point::new(100.0, 100.0))));
    state.apply_command(EditorCommand::Redo);
    assert_eq!(state.document.find_card("card-a").unwrap().position, Point::new(200.0, 150.0));

    // Adding a card or changing a connection is refused with a reason and changes nothing.
    let cards = state.document.cards.len();
    let edits = [
        EditorCommand::CreateCard { id: "card-c".into(), title: "C".into(), position: Point::new(0.0, 0.0), size: None },
        EditorCommand::ConnectSkills { from_id: "card-b".into(), to_id: "card-a".into() },
        EditorCommand::DisconnectSkills { from_id: "card-a".into(), to_id: "card-b".into() },
    ];
    for edit in edits {
        let events = state.apply_command(edit.clone());
        assert!(
            events.len() == 1 && matches!(&events[0], EditorEvent::Error { message } if message.contains("Only card positions")),
            "{:?} answered {:?}",
            edit,
            events
        );
    }
    assert_eq!(state.document.cards.len(), cards);
    assert_eq!(state.document.connections, connections);

    // Leaving layout-only restores content editing.
    state.apply_command(EditorCommand::SetLayoutOnly { layout_only: false });
    let created = state.apply_command(EditorCommand::CreateCard { id: "card-c".into(), title: "C".into(), position: Point::new(0.0, 0.0), size: None });
    assert!(created.iter().any(|e| matches!(e, EditorEvent::CardCreated { .. })));
}

/// Cards A, B and C near the origin and D far away, each 180×80.
fn multiselect_state() -> EditorState {
    let mut state = EditorState::new();
    for (id, x, y) in [("card-a", 100.0, 100.0), ("card-b", 400.0, 100.0), ("card-c", 100.0, 400.0), ("card-d", 1000.0, 1000.0)] {
        state.apply_command(EditorCommand::CreateCard {
            id: id.into(),
            title: id.to_uppercase(),
            position: Point::new(x, y),
            size: Some(Size::new(180.0, 80.0)),
        });
    }
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-b".into(), to_id: "card-d".into() });
    // Opened as a saved document: its editing history starts empty.
    let document = state.document.clone();
    state.apply_command(EditorCommand::LoadDocument { document });
    state
}

fn press(state: &mut EditorState, world: Point, shift_key: bool) -> Vec<EditorEvent> {
    let s = state.camera.world_to_screen(world);
    state.apply_command(EditorCommand::PointerDown { screen_x: s.x, screen_y: s.y, shift_key })
}

fn move_to(state: &mut EditorState, world: Point) -> Vec<EditorEvent> {
    let s = state.camera.world_to_screen(world);
    state.apply_command(EditorCommand::PointerMove { screen_x: s.x, screen_y: s.y })
}

fn release(state: &mut EditorState, world: Point) -> Vec<EditorEvent> {
    let s = state.camera.world_to_screen(world);
    state.apply_command(EditorCommand::PointerUp { screen_x: s.x, screen_y: s.y })
}

fn box_select(state: &mut EditorState, from: Point, to: Point) -> Vec<EditorEvent> {
    let mut events = press(state, from, true);
    events.extend(move_to(state, to));
    events.extend(release(state, to));
    events
}

fn position(state: &EditorState, id: &str) -> Point {
    state.document.find_card(id).unwrap().position
}

fn selected_labels(state: &EditorState) -> Vec<String> {
    state.get_label_layouts().into_iter().filter(|l| l.selected).map(|l| l.card_id).collect()
}

#[test]
fn test_multiselect_box_selects_the_cards_it_touches_at_any_camera() {
    let cameras = [
        Camera::new(0.0, 0.0, 1.0),
        Camera::new(-300.0, 120.0, 0.5),
        Camera::new(250.0, -80.0, 2.0),
        Camera::new(40.0, 30.0, MIN_ZOOM),
        Camera::new(-200.0, -150.0, MAX_ZOOM),
    ];
    for camera in cameras {
        let mut state = multiselect_state();
        state.camera = camera;

        // Shift on the empty canvas starts a box; the selection follows the box while it is drawn.
        let down = press(&mut state, Point::new(50.0, 50.0), true);
        assert!(!down.iter().any(|e| matches!(e, EditorEvent::CameraChanged { .. })), "zoom {}: {down:?}", camera.zoom);
        assert!(matches!(state.interaction, InteractionState::SelectingBox { .. }));
        let partial = move_to(&mut state, Point::new(300.0, 150.0));
        assert_eq!(state.selected_card_ids, vec!["card-a"], "zoom {}", camera.zoom);
        assert!(partial.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: Some(id), selected_ids, .. } if id == "card-a" && selected_ids == &vec!["card-a".to_string()])));
        let drawn = state.selection_box().expect("box is drawn");
        assert!((drawn.x - 50.0).abs() < 1e-3 && (drawn.y - 50.0).abs() < 1e-3);
        assert!((drawn.width - 250.0).abs() < 1e-2 && (drawn.height - 100.0).abs() < 1e-2, "zoom {}: {drawn:?}", camera.zoom);

        // B's left edge is at x = 400: a box reaching x = 401 touches it, C (y >= 400) and D stay out.
        let grown = move_to(&mut state, Point::new(401.0, 150.0));
        assert!(grown.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: None, title: None, selected_ids } if selected_ids == &vec!["card-a".to_string(), "card-b".to_string()])));
        assert!(grown.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })));
        assert!(!grown.iter().any(|e| matches!(e, EditorEvent::CardMoved { .. } | EditorEvent::CameraChanged { .. })));
        let up = release(&mut state, Point::new(401.0, 150.0));
        assert!(!up.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { .. })), "selecting is not an edit");
        assert_eq!(state.selected_card_ids, vec!["card-a", "card-b"], "zoom {}", camera.zoom);
        assert_eq!(state.selected_card_id(), None);
        assert_eq!(selected_labels(&state), vec!["card-a", "card-b"]);
        assert_eq!(state.selection_box(), None);
        assert!(state.undo_stack.is_empty());

        // A box drawn the other way round selects by the same area.
        box_select(&mut state, Point::new(290.0, 500.0), Point::new(0.0, 0.0));
        assert_eq!(state.selected_card_ids, vec!["card-a", "card-c"], "zoom {}", camera.zoom);

        // A box that touches no card clears the selection.
        box_select(&mut state, Point::new(600.0, 600.0), Point::new(700.0, 700.0));
        assert!(state.selected_card_ids.is_empty());
    }
}

#[test]
fn test_multiselect_plain_presses_keep_single_selection_and_pan() {
    let mut state = multiselect_state();
    box_select(&mut state, Point::new(0.0, 0.0), Point::new(700.0, 200.0));
    assert_eq!(state.selected_card_ids, vec!["card-a", "card-b"]);

    // Without Shift the empty canvas pans and clears the selection.
    press(&mut state, Point::new(700.0, 700.0), false);
    assert!(state.selected_card_ids.is_empty());
    let pan = state.apply_command(EditorCommand::PointerMove { screen_x: 720.0, screen_y: 690.0 });
    assert!(pan.iter().any(|e| matches!(e, EditorEvent::CameraChanged { .. })));
    state.apply_command(EditorCommand::PointerUp { screen_x: 720.0, screen_y: 690.0 });

    // Shift on a card does not draw a box: the card alone is selected and dragged.
    state.camera = Camera::default();
    box_select(&mut state, Point::new(0.0, 0.0), Point::new(700.0, 200.0));
    state.apply_command(EditorCommand::SelectCard { id: Some("card-c".into()) });
    assert_eq!(state.selected_card_ids, vec!["card-c"]);
    press(&mut state, Point::new(120.0, 420.0), true);
    move_to(&mut state, Point::new(140.0, 430.0));
    release(&mut state, Point::new(140.0, 430.0));
    assert_eq!(position(&state, "card-c"), Point::new(120.0, 410.0));
    assert_eq!(position(&state, "card-a"), Point::new(100.0, 100.0));
}

#[test]
fn test_multiselect_drag_moves_the_selection_as_one_undo_step() {
    for zoom in [0.5, 1.0, 2.5] {
        let mut state = multiselect_state();
        state.camera = Camera::new(30.0, -20.0, zoom);
        let connections = state.document.connections.clone();
        box_select(&mut state, Point::new(0.0, 0.0), Point::new(450.0, 450.0));
        assert_eq!(state.selected_card_ids, vec!["card-a", "card-b", "card-c"]);

        // Pressing a selected card keeps the selection; the move carries all of it.
        let down = press(&mut state, Point::new(420.0, 130.0), false);
        assert!(!down.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { .. })), "{down:?}");
        move_to(&mut state, Point::new(470.0, 160.0));
        let moved = move_to(&mut state, Point::new(520.0, 190.0));
        let moved_ids: Vec<&str> = moved.iter().filter_map(|e| match e { EditorEvent::CardMoved { card_id, .. } => Some(card_id.as_str()), _ => None }).collect();
        assert_eq!(moved_ids, vec!["card-a", "card-b", "card-c"], "zoom {zoom}");
        let labels = moved.iter().find_map(|e| match e { EditorEvent::LabelsUpdated { labels } => Some(labels.clone()), _ => None }).expect("labels follow the move");
        for label in &labels {
            assert_eq!(label.world_rect, state.document.find_card(&label.card_id).unwrap().world_bounds(), "label of {} left its card", label.card_id);
        }
        for (id, start) in [("card-a", (100.0, 100.0)), ("card-b", (400.0, 100.0)), ("card-c", (100.0, 400.0))] {
            let p = position(&state, id);
            assert!((p.x - (start.0 + 100.0)).abs() < 1e-3 && (p.y - (start.1 + 60.0)).abs() < 1e-3, "zoom {zoom}: {id} at {p:?}");
        }
        assert_eq!(position(&state, "card-d"), Point::new(1000.0, 1000.0));
        assert!(state.undo_stack.is_empty(), "nothing is recorded before the release");

        let up = release(&mut state, Point::new(520.0, 190.0));
        assert_eq!(up.iter().filter(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })).count(), 1);
        assert_eq!(state.undo_stack.len(), 1);
        assert_eq!(state.selected_card_ids, vec!["card-a", "card-b", "card-c"]);
        assert_eq!(state.document.connections, connections, "connections stay between the same Skills");
        let after = state.document.clone();

        // One undo restores every card of the drag; one redo moves them all again.
        let undone = state.apply_command(EditorCommand::Undo);
        assert_eq!(undone.iter().filter(|e| matches!(e, EditorEvent::CardMoved { .. })).count(), 3);
        assert!(undone.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: false, can_redo: true })));
        assert_eq!(position(&state, "card-a"), Point::new(100.0, 100.0));
        assert_eq!(position(&state, "card-b"), Point::new(400.0, 100.0));
        assert_eq!(position(&state, "card-c"), Point::new(100.0, 400.0));
        assert!(state.undo_stack.is_empty());
        let redone = state.apply_command(EditorCommand::Redo);
        assert!(redone.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })));
        assert_eq!(state.document, after);
        assert_eq!(state.selected_card_ids, vec!["card-a", "card-b", "card-c"], "undo and redo keep the selection");

        // Pressing a card outside the selection selects and drags that card alone.
        let down = press(&mut state, Point::new(1010.0, 1010.0), false);
        assert!(down.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: Some(id), .. } if id == "card-d")));
        move_to(&mut state, Point::new(1030.0, 1010.0));
        release(&mut state, Point::new(1030.0, 1010.0));
        assert_eq!(position(&state, "card-d"), Point::new(1020.0, 1000.0));
        assert_eq!(position(&state, "card-a"), after.find_card("card-a").unwrap().position);
        assert_eq!(state.undo_stack.len(), 2);
    }
}

#[test]
fn test_multiselect_drag_stays_within_world_limits_keeping_relative_positions() {
    // Near ±1,000,000 an f32 step is 0.0625, so positions compare within a small tolerance.
    let near = |p: Point, x: f32, y: f32| (p.x - x).abs() < 0.2 && (p.y - y).abs() < 0.2;
    let mut state = EditorState::new();
    for (id, x, y) in [("left", MAX_WORLD_COORD - 500.0, 0.0), ("right", MAX_WORLD_COORD - 100.0, 300.0)] {
        state.apply_command(EditorCommand::CreateCard { id: id.into(), title: id.into(), position: Point::new(x, y), size: None });
    }
    state.camera = Camera::new(0.0, 0.0, MIN_ZOOM);
    box_select(&mut state, Point::new(MAX_WORLD_COORD - 600.0, -50.0), Point::new(MAX_WORLD_COORD, 500.0));
    assert_eq!(state.selected_card_ids, vec!["left", "right"]);

    // Drag far to the right: the group stops when the rightmost card reaches the limit.
    let grab = Point::new(MAX_WORLD_COORD - 490.0, 10.0);
    press(&mut state, grab, false);
    move_to(&mut state, Point::new(grab.x + 5000.0, grab.y + 100.0));
    release(&mut state, Point::new(grab.x + 5000.0, grab.y + 100.0));
    assert!(near(position(&state, "right"), MAX_WORLD_COORD, 400.0), "{:?}", position(&state, "right"));
    assert!(near(position(&state, "left"), MAX_WORLD_COORD - 400.0, 100.0), "{:?}", position(&state, "left"));

    // And towards the minimum on both axes: the group stops at the first card that reaches it.
    let grab = Point::new(MAX_WORLD_COORD - 390.0, 110.0);
    let s = state.camera.world_to_screen(grab);
    state.apply_command(EditorCommand::PointerDown { screen_x: s.x, screen_y: s.y, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: -1.0e9, screen_y: -1.0e9 });
    state.apply_command(EditorCommand::PointerUp { screen_x: -1.0e9, screen_y: -1.0e9 });
    assert!(near(position(&state, "left"), MIN_WORLD_COORD, MIN_WORLD_COORD), "{:?}", position(&state, "left"));
    assert!(near(position(&state, "right"), MIN_WORLD_COORD + 400.0, MIN_WORLD_COORD + 300.0), "{:?}", position(&state, "right"));

    // Undo walks back through both limited drags.
    state.apply_command(EditorCommand::Undo);
    assert!(near(position(&state, "right"), MAX_WORLD_COORD, 400.0));
    state.apply_command(EditorCommand::Undo);
    assert_eq!(position(&state, "left"), Point::new(MAX_WORLD_COORD - 500.0, 0.0));
    assert_eq!(position(&state, "right"), Point::new(MAX_WORLD_COORD - 100.0, 300.0));
}

#[test]
fn test_multiselect_interrupted_gestures_keep_history_and_selection() {
    let mut state = multiselect_state();
    box_select(&mut state, Point::new(0.0, 0.0), Point::new(450.0, 150.0));

    // Undo while a selection is being dragged puts every card back and records nothing.
    press(&mut state, Point::new(120.0, 120.0), false);
    move_to(&mut state, Point::new(220.0, 220.0));
    let undo = state.apply_command(EditorCommand::Undo);
    assert_eq!(undo.iter().filter(|e| matches!(e, EditorEvent::CardMoved { .. })).count(), 2);
    assert_eq!(state.interaction, InteractionState::Idle);
    release(&mut state, Point::new(300.0, 300.0));
    assert_eq!(position(&state, "card-a"), Point::new(100.0, 100.0));
    assert_eq!(position(&state, "card-b"), Point::new(400.0, 100.0));
    assert!(state.undo_stack.is_empty());

    // A box interrupted by undo ends with the selection it had reached.
    press(&mut state, Point::new(50.0, 350.0), true);
    move_to(&mut state, Point::new(150.0, 450.0));
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.selection_box(), None);
    assert_eq!(state.selected_card_ids, vec!["card-c"]);
}

#[test]
fn test_multiselect_selection_is_session_state_outside_the_document() {
    let mut state = multiselect_state();
    box_select(&mut state, Point::new(0.0, 0.0), Point::new(450.0, 450.0));
    let snapshot = state.apply_command(EditorCommand::ExportSnapshot);
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("selected"), "the saved document carries no selection: {json}");

    // Loading a document keeps the selected cards it still holds, and clears the history.
    let mut reloaded = state.document.clone();
    reloaded.cards.retain(|c| c.id != "card-b");
    let events = state.apply_command(EditorCommand::LoadDocument { document: reloaded });
    assert!(events.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_ids, .. } if selected_ids == &vec!["card-a".to_string(), "card-c".to_string()])));
    assert_eq!(state.selected_card_ids, vec!["card-a", "card-c"]);
    assert!(state.undo_stack.is_empty());

    // A fresh editor (a reload) starts with no selection.
    assert!(EditorState::new().selected_card_ids.is_empty());

    // An old client's press has no shift_key; it pans as before.
    let cmd: EditorCommand = serde_json::from_str(r#"{"type":"PointerDown","screen_x":1.0,"screen_y":2.0}"#).unwrap();
    assert_eq!(cmd, EditorCommand::PointerDown { screen_x: 1.0, screen_y: 2.0, shift_key: false });
    let cmd: EditorCommand = serde_json::from_str(r#"{"type":"PointerDown","screen_x":1.0,"screen_y":2.0,"shift_key":true}"#).unwrap();
    assert_eq!(cmd, EditorCommand::PointerDown { screen_x: 1.0, screen_y: 2.0, shift_key: true });
}

#[test]
fn test_multiselect_follows_canvas_edit_permissions() {
    // Read-only: Shift on the empty canvas pans; nothing can be box-selected or moved.
    let mut state = multiselect_state();
    let document = state.document.clone();
    state.apply_command(EditorCommand::SetReadOnly { read_only: true });
    press(&mut state, Point::new(50.0, 50.0), true);
    let pan = state.apply_command(EditorCommand::PointerMove { screen_x: 450.0, screen_y: 450.0 });
    state.apply_command(EditorCommand::PointerUp { screen_x: 450.0, screen_y: 450.0 });
    assert!(pan.iter().any(|e| matches!(e, EditorEvent::CameraChanged { .. })));
    assert!(state.selected_card_ids.is_empty());
    assert_eq!(state.document, document);
    assert!(state.undo_stack.is_empty());

    // Layout-only: a selection is arranged and undone like on an editable canvas.
    let mut state = multiselect_state();
    state.apply_command(EditorCommand::SetLayoutOnly { layout_only: true });
    box_select(&mut state, Point::new(0.0, 0.0), Point::new(450.0, 150.0));
    press(&mut state, Point::new(120.0, 120.0), false);
    move_to(&mut state, Point::new(170.0, 120.0));
    release(&mut state, Point::new(170.0, 120.0));
    assert_eq!(position(&state, "card-a"), Point::new(150.0, 100.0));
    assert_eq!(position(&state, "card-b"), Point::new(450.0, 100.0));
    state.apply_command(EditorCommand::Undo);
    assert_eq!(position(&state, "card-b"), Point::new(400.0, 100.0));
}

/// A → B → C, opened as a saved document, with B selected.
fn deletion_state() -> EditorState {
    let mut state = EditorState::new();
    for (id, x) in [("card-a", 100.0), ("card-b", 400.0), ("card-c", 700.0)] {
        state.apply_command(EditorCommand::CreateCard { id: id.into(), title: id.to_uppercase(), position: Point::new(x, 120.0), size: None });
    }
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    state.apply_command(EditorCommand::ConnectSkills { from_id: "card-b".into(), to_id: "card-c".into() });
    let document = state.document.clone();
    state.apply_command(EditorCommand::LoadDocument { document });
    state.apply_command(EditorCommand::SelectCard { id: Some("card-b".into()) });
    state
}

fn edges(state: &EditorState) -> Vec<String> {
    let mut list: Vec<String> = state.document.connections.iter().map(|c| format!("{}>{}", c.from_id, c.to_id)).collect();
    list.sort();
    list
}

#[test]
fn test_deletion_removes_a_card_with_its_connections_as_one_undo_step() {
    let mut state = deletion_state();
    let saved = state.document.clone();
    let deleted = state.apply_command(EditorCommand::DeleteCard { id: "card-b".into() });
    assert!(deleted.iter().any(|e| matches!(e, EditorEvent::CardDeleted { card_id } if card_id == "card-b")));
    assert!(deleted.iter().any(|e| matches!(e, EditorEvent::ConnectionsUpdated { connections } if connections.is_empty())));
    assert!(deleted.iter().any(|e| matches!(e, EditorEvent::SelectionChanged { selected_id: None, selected_ids, .. } if selected_ids.is_empty())));
    assert!(deleted.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })));
    let labels = deleted.iter().find_map(|e| match e { EditorEvent::LabelsUpdated { labels } => Some(labels.clone()), _ => None }).expect("labels follow the deletion");
    assert_eq!(labels.iter().map(|l| l.card_id.as_str()).collect::<Vec<_>>(), vec!["card-a", "card-c"]);
    // Nothing in the document names the deleted card any more.
    assert!(state.document.find_card("card-b").is_none());
    assert!(edges(&state).is_empty());
    assert_eq!(state.undo_stack.len(), 1);

    // One undo puts back the card at its place, position and title, with both its connections.
    let undone = state.apply_command(EditorCommand::Undo);
    assert!(undone.iter().any(|e| matches!(e, EditorEvent::CardRestored { card_id } if card_id == "card-b")));
    assert!(undone.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: false, can_redo: true })));
    assert!(undone.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { labels } if labels.len() == 3)));
    assert_eq!(state.document, saved);
    // One redo deletes it again.
    let redone = state.apply_command(EditorCommand::Redo);
    assert!(redone.iter().any(|e| matches!(e, EditorEvent::CardDeleted { card_id } if card_id == "card-b")));
    assert!(state.document.find_card("card-b").is_none() && edges(&state).is_empty());
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.document, saved);

    // A deletion during a drag first puts the dragged cards back.
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 140.0, shift_key: false });
    state.apply_command(EditorCommand::PointerMove { screen_x: 220.0, screen_y: 240.0 });
    state.apply_command(EditorCommand::DeleteCard { id: "card-c".into() });
    state.apply_command(EditorCommand::PointerUp { screen_x: 300.0, screen_y: 300.0 });
    assert_eq!(state.document.find_card("card-a").unwrap().position, Point::new(100.0, 120.0));
    state.apply_command(EditorCommand::Undo);
    assert_eq!(state.document, saved);
}

#[test]
fn test_deletion_connection_changes_are_undo_steps_so_undo_never_forms_a_cycle() {
    let mut state = deletion_state();
    // Remove A → B, then add C → A, which only the removal allowed.
    state.apply_command(EditorCommand::DisconnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    let added = state.apply_command(EditorCommand::ConnectSkills { from_id: "card-c".into(), to_id: "card-a".into() });
    assert!(added.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { can_undo: true, can_redo: false })));
    assert_eq!(edges(&state), vec!["card-b>card-c", "card-c>card-a"]);
    // Undoing in order removes C → A before A → B comes back.
    state.apply_command(EditorCommand::Undo);
    assert_eq!(edges(&state), vec!["card-b>card-c"]);
    let undone = state.apply_command(EditorCommand::Undo);
    assert!(undone.iter().any(|e| matches!(e, EditorEvent::ConnectionsUpdated { connections } if connections.len() == 2)));
    assert_eq!(edges(&state), vec!["card-a>card-b", "card-b>card-c"]);
    state.apply_command(EditorCommand::Redo);
    state.apply_command(EditorCommand::Redo);
    assert_eq!(edges(&state), vec!["card-b>card-c", "card-c>card-a"]);
    // A rejected connection is not an edit.
    let cycle = state.apply_command(EditorCommand::ConnectSkills { from_id: "card-a".into(), to_id: "card-b".into() });
    assert!(cycle.iter().any(|e| matches!(e, EditorEvent::ConnectionRejected { .. })));
    assert!(!cycle.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { .. })));
    assert_eq!(state.undo_stack.len(), 2);
}

#[test]
fn test_deletion_restore_validates_connections_again() {
    let mut state = deletion_state();
    state.apply_command(EditorCommand::DeleteCard { id: "card-b".into() });
    // A change outside the editing history (as a loaded document could bring) adds C → A.
    state.document.try_add_connection("card-c", "card-a").unwrap();
    state.apply_command(EditorCommand::Undo);
    // B is back; A → B fits, but B → C would close A → B → C → A and stays out.
    assert!(state.document.find_card("card-b").is_some());
    assert_eq!(edges(&state), vec!["card-a>card-b", "card-c>card-a"]);
}

#[test]
fn test_deletion_follows_canvas_permissions_and_reports_unknown_cards() {
    let mut state = deletion_state();
    let saved = state.document.clone();
    let unknown = state.apply_command(EditorCommand::DeleteCard { id: "card-x".into() });
    assert!(unknown.len() == 1 && matches!(&unknown[0], EditorEvent::Error { message } if message.contains("card-x")));
    assert!(state.undo_stack.is_empty());
    for (read_only, layout_only) in [(true, false), (false, true)] {
        let mut state = deletion_state();
        state.apply_command(EditorCommand::SetReadOnly { read_only });
        state.apply_command(EditorCommand::SetLayoutOnly { layout_only });
        let refused = state.apply_command(EditorCommand::DeleteCard { id: "card-b".into() });
        assert!(refused.len() == 1 && matches!(&refused[0], EditorEvent::Error { .. }), "{refused:?}");
        assert_eq!(state.document, saved);
    }
    // The command and its events cross the JSON boundary.
    let cmd: EditorCommand = serde_json::from_str(r#"{"type":"DeleteCard","id":"card-b"}"#).unwrap();
    assert_eq!(cmd, EditorCommand::DeleteCard { id: "card-b".into() });
    for event in [EditorEvent::CardDeleted { card_id: "card-b".into() }, EditorEvent::CardRestored { card_id: "card-b".into() }] {
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(serde_json::from_str::<EditorEvent>(&json).unwrap(), event);
    }
}
