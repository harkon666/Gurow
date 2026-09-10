use crate::geometry::{Camera, Point, Rect, Size};
use crate::protocol::{EditorCommand, EditorEvent};
use crate::state::EditorState;

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


