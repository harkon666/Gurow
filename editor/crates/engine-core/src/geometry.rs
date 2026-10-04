use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
/// A point in either world or screen coordinates, depending on the API call.
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    /// Creates a point from its two coordinates.
    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
/// A width and height in the coordinate space of the caller.
pub struct Size {
    pub width: f32,
    pub height: f32,
}

impl Size {
    /// Creates a size from width and height.
    pub fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
/// An axis-aligned rectangle used for card bounds and label placement.
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    /// Creates a rectangle from its origin and dimensions.
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Reports whether a point lies inside the rectangle, including edges.
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.x + self.width && p.y >= self.y && p.y <= self.y + self.height
    }
}

pub const MIN_WORLD_COORD: f32 = -1_000_000.0;
pub const MAX_WORLD_COORD: f32 = 1_000_000.0;
pub const MIN_ZOOM: f32 = 0.1;
pub const MAX_ZOOM: f32 = 4.0;

/// Clamps one world coordinate to the editor's supported finite range.
pub fn clamp_world_coord(val: f32) -> f32 {
    val.clamp(MIN_WORLD_COORD, MAX_WORLD_COORD)
}

/// Clamps both coordinates of a world-space point.
pub fn clamp_world_point(p: Point) -> Point {
    Point::new(clamp_world_coord(p.x), clamp_world_coord(p.y))
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
/// Camera transform shared by hit testing, labels, and rendering.
///
/// Offsets are screen-space values. Zoom is clamped to the product bounds
/// [`MIN_ZOOM`, `MAX_ZOOM`], and world coordinates are clamped to the finite
/// editor range when the camera moves.
pub struct Camera {
    pub offset_x: f32,
    pub offset_y: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            offset_x: 0.0,
            offset_y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Camera {
    /// Creates a camera and clamps its zoom and visible world origin.
    pub fn new(offset_x: f32, offset_y: f32, zoom: f32) -> Self {
        let mut cam = Self {
            offset_x,
            offset_y,
            zoom: zoom.clamp(MIN_ZOOM, MAX_ZOOM),
        };
        cam.clamp_bounds();
        cam
    }

    /// Converts a world-space point to screen-space coordinates.
    pub fn world_to_screen(&self, world_p: Point) -> Point {
        Point::new(
            world_p.x * self.zoom + self.offset_x,
            world_p.y * self.zoom + self.offset_y,
        )
    }

    /// Converts a screen-space point back to world space.
    pub fn screen_to_world(&self, screen_p: Point) -> Point {
        Point::new(
            (screen_p.x - self.offset_x) / self.zoom,
            (screen_p.y - self.offset_y) / self.zoom,
        )
    }

    /// Moves the camera by a screen-space delta, then enforces world bounds.
    pub fn pan(&mut self, delta_x: f32, delta_y: f32) {
        self.offset_x += delta_x;
        self.offset_y += delta_y;
        self.clamp_bounds();
    }

    /// Changes zoom while keeping the world point under `anchor_screen` fixed.
    pub fn zoom_at(&mut self, anchor_screen: Point, factor: f32) {
        let old_zoom = self.zoom;
        let new_zoom = (old_zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        if (new_zoom - old_zoom).abs() < 1e-6 {
            return;
        }
        let anchor_world = self.screen_to_world(anchor_screen);
        self.zoom = new_zoom;
        self.offset_x = anchor_screen.x - anchor_world.x * new_zoom;
        self.offset_y = anchor_screen.y - anchor_world.y * new_zoom;
        self.clamp_bounds();
    }

    /// Keeps the visible world origin inside the editor's finite coordinate range.
    pub fn clamp_bounds(&mut self) {
        let top_left_world = self.screen_to_world(Point::ZERO);
        let clamped_x = clamp_world_coord(top_left_world.x);
        let clamped_y = clamp_world_coord(top_left_world.y);
        if (top_left_world.x - clamped_x).abs() > 1e-5 {
            self.offset_x = -clamped_x * self.zoom;
        }
        if (top_left_world.y - clamped_y).abs() > 1e-5 {
            self.offset_y = -clamped_y * self.zoom;
        }
    }
}
