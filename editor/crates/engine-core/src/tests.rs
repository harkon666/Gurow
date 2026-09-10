use crate::geometry::{Camera, Point, Rect, Size};
use crate::protocol::{EditorCommand, EditorEvent};
use crate::state::{EditorState, InteractionState};

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
        screen_y: 70.0,
    });
    assert_eq!(state.selected_card_id.as_deref(), Some("card-a"));
    assert!(events.iter().any(|e| matches!(
        e,
        EditorEvent::SelectionChanged {
            selected_id: Some(id),
            title: Some(t)
        } if id == "card-a" && t == "Card A"
    )));

    // PointerDown outside -> deselects
    let deselect_events = state.apply_command(EditorCommand::PointerDown {
        screen_x: 300.0,
        screen_y: 300.0,
    });
    assert_eq!(state.selected_card_id, None);
    assert!(deselect_events.iter().any(|e| matches!(
        e,
        EditorEvent::SelectionChanged {
            selected_id: None,
            title: None
        }
    )));
}

#[test]
fn test_label_layouts_with_camera() {
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
    assert_eq!(label.screen_rect, Rect::new(120.0, 90.0, 200.0, 100.0));
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
            screen_y: 250.0,
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
        },
        EditorEvent::SelectionChanged {
            selected_id: None,
            title: None,
        },
        EditorEvent::LabelsUpdated {
            labels: vec![crate::protocol::LabelLayout {
                card_id: "card-1".into(),
                title: "Title 1".into(),
                screen_rect: Rect::new(10.0, 20.0, 180.0, 80.0),
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
            screen_y: screen_pointer.y,
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
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0 });
    let up_events = state.apply_command(EditorCommand::PointerUp { screen_x: 120.0, screen_y: 120.0 });
    assert_eq!(state.undo_stack.len(), 0);
    assert!(!up_events.iter().any(|e| matches!(e, EditorEvent::HistoryChanged { .. })));

    // 2. Dragging card creates exactly one undo step on PointerUp
    state.apply_command(EditorCommand::PointerDown { screen_x: 120.0, screen_y: 120.0 });
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
    state.apply_command(EditorCommand::PointerDown { screen_x: 10.0, screen_y: 10.0 });
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
    assert!(zoom_events.iter().any(|e| matches!(e, EditorEvent::LabelsUpdated { .. })));
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
    state.apply_command(EditorCommand::PointerDown { screen_x: 100.0, screen_y: 100.0 });
    state.apply_command(EditorCommand::PointerMove { screen_x: 200.0, screen_y: 200.0 });
    state.apply_command(EditorCommand::PointerUp { screen_x: 200.0, screen_y: 200.0 });

    let card = state.document.find_card("card-drag-bug").unwrap();
    assert_eq!(card.position, Point::new(200.0, 200.0));
    assert_eq!(state.undo_stack.len(), 1);

    // Drag 2 (interrupted): Start dragging towards 300
    state.apply_command(EditorCommand::PointerDown { screen_x: 200.0, screen_y: 200.0 });
    state.apply_command(EditorCommand::PointerMove { screen_x: 250.0, screen_y: 250.0 });
    assert!(matches!(state.interaction, InteractionState::DraggingCard { .. }));

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


