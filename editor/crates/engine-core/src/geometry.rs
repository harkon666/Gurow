use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}

impl Size {
    pub fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.x + self.width && p.y >= self.y && p.y <= self.y + self.height
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
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
    pub fn new(offset_x: f32, offset_y: f32, zoom: f32) -> Self {
        Self {
            offset_x,
            offset_y,
            zoom,
        }
    }

    pub fn world_to_screen(&self, world_p: Point) -> Point {
        Point::new(
            world_p.x * self.zoom + self.offset_x,
            world_p.y * self.zoom + self.offset_y,
        )
    }

    pub fn screen_to_world(&self, screen_p: Point) -> Point {
        Point::new(
            (screen_p.x - self.offset_x) / self.zoom,
            (screen_p.y - self.offset_y) / self.zoom,
        )
    }

    pub fn world_rect_to_screen(&self, rect: Rect) -> Rect {
        let top_left = self.world_to_screen(Point::new(rect.x, rect.y));
        Rect::new(
            top_left.x,
            top_left.y,
            rect.width * self.zoom,
            rect.height * self.zoom,
        )
    }
}
