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

    /// Reports whether two rectangles overlap or touch.
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x <= other.x + other.width
            && other.x <= self.x + self.width
            && self.y <= other.y + other.height
            && other.y <= self.y + self.height
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

/// Screen-space radius, in CSS pixels, of a card's connection point.
pub const CONNECTION_HANDLE_RADIUS_PX: f32 = 9.0;
/// Screen-space distance, in CSS pixels, within which a press selects a connection.
pub const CONNECTION_HIT_TOLERANCE_PX: f32 = 6.0;
/// Segments used to draw and to hit-test a connection curve.
pub const CONNECTION_CURVE_SEGMENTS: usize = 24;

/// A side of a card, where a connection leaves or arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    pub const ALL: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

    /// The outward unit normal of the side.
    pub fn normal(self) -> Point {
        match self {
            Side::Top => Point::new(0.0, -1.0),
            Side::Right => Point::new(1.0, 0.0),
            Side::Bottom => Point::new(0.0, 1.0),
            Side::Left => Point::new(-1.0, 0.0),
        }
    }

    pub fn opposite(self) -> Side {
        match self {
            Side::Top => Side::Bottom,
            Side::Right => Side::Left,
            Side::Bottom => Side::Top,
            Side::Left => Side::Right,
        }
    }
}

impl Rect {
    pub fn center(&self) -> Point {
        Point::new(self.x + self.width * 0.5, self.y + self.height * 0.5)
    }

    /// The middle of one side of the rectangle.
    pub fn side_midpoint(&self, side: Side) -> Point {
        let c = self.center();
        match side {
            Side::Top => Point::new(c.x, self.y),
            Side::Right => Point::new(self.x + self.width, c.y),
            Side::Bottom => Point::new(c.x, self.y + self.height),
            Side::Left => Point::new(self.x, c.y),
        }
    }
}

/// The sides a connection from `from` to `to` leaves and enters by: the facing
/// sides across the wider gap between the two boxes, so the curve runs through
/// the open space between them. A tie favours left-to-right.
pub fn facing_sides(from: &Rect, to: &Rect) -> (Side, Side) {
    let (a, b) = (from.center(), to.center());
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let horizontal_gap = dx.abs() - (from.width + to.width) * 0.5;
    let vertical_gap = dy.abs() - (from.height + to.height) * 0.5;
    let side = if horizontal_gap >= vertical_gap {
        if dx >= 0.0 { Side::Right } else { Side::Left }
    } else if dy >= 0.0 {
        Side::Bottom
    } else {
        Side::Top
    };
    (side, side.opposite())
}

/// The cubic Bézier control points of a connection leaving `start` through
/// `start_side` and arriving at `end` through `end_side`. Each end leaves along
/// its side's normal, so the arrowhead points into the side it reaches.
pub fn connection_curve(start: Point, start_side: Side, end: Point, end_side: Side) -> [Point; 4] {
    let span = match start_side {
        Side::Left | Side::Right => (end.x - start.x).abs(),
        Side::Top | Side::Bottom => (end.y - start.y).abs(),
    };
    let reach = span.max(40.0) * 0.5;
    let (n0, n1) = (start_side.normal(), end_side.normal());
    [
        start,
        Point::new(start.x + n0.x * reach, start.y + n0.y * reach),
        Point::new(end.x + n1.x * reach, end.y + n1.y * reach),
        end,
    ]
}

/// The curve of a connection between two cards, attached to their facing sides.
/// Rendering and hit testing share this curve, so a press lands on the edge
/// that is drawn.
pub fn connection_route(from: &Rect, to: &Rect) -> [Point; 4] {
    let (start_side, end_side) = facing_sides(from, to);
    connection_curve(from.side_midpoint(start_side), start_side, to.side_midpoint(end_side), end_side)
}

/// The curve of a connection being dragged from a card to a free point.
pub fn connection_route_to_point(from: &Rect, point: Point) -> [Point; 4] {
    connection_route(from, &Rect::new(point.x, point.y, 0.0, 0.0))
}

/// The point of a cubic Bézier at `t` in [0, 1].
pub fn cubic_point(curve: &[Point; 4], t: f32) -> Point {
    let u = 1.0 - t;
    let (c0, c1, c2, c3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    Point::new(
        c0 * curve[0].x + c1 * curve[1].x + c2 * curve[2].x + c3 * curve[3].x,
        c0 * curve[0].y + c1 * curve[1].y + c2 * curve[2].y + c3 * curve[3].y,
    )
}

/// The derivative of a cubic Bézier at `t` in [0, 1]: the curve's direction there.
pub fn cubic_tangent(curve: &[Point; 4], t: f32) -> Point {
    let u = 1.0 - t;
    let (d0, d1, d2, d3) = (-3.0 * u * u, 3.0 * u * u - 6.0 * u * t, 6.0 * u * t - 3.0 * t * t, 3.0 * t * t);
    Point::new(
        d0 * curve[0].x + d1 * curve[1].x + d2 * curve[2].x + d3 * curve[3].x,
        d0 * curve[0].y + d1 * curve[1].y + d2 * curve[2].y + d3 * curve[3].y,
    )
}

/// The distance from `p` to the segment `a`–`b`.
pub fn distance_to_segment(p: Point, a: Point, b: Point) -> f32 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length_sq = dx * dx + dy * dy;
    let t = if length_sq > 0.0 {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / length_sq).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (a.x + t * dx, a.y + t * dy);
    ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt()
}
