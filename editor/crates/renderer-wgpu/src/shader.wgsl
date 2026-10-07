struct Uniforms {
    camera_offset: vec2<f32>,
    viewport_size: vec2<f32>,
    camera_zoom: f32,
    _pad0: f32,
    _pad1: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

// Card Quad Pass
struct CardInstanceInput {
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) selected: f32,
};

struct CardVertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) local_uv: vec2<f32>,
    @location(1) card_size: vec2<f32>,
    @location(2) selected: f32,
};

@vertex
fn vs_card(
    @builtin(vertex_index) vertex_idx: u32,
    instance: CardInstanceInput,
) -> CardVertexOutput {
    var out: CardVertexOutput;
    
    var uv = vec2<f32>(0.0, 0.0);
    switch (vertex_idx) {
        case 0u: { uv = vec2<f32>(0.0, 0.0); }
        case 1u: { uv = vec2<f32>(1.0, 0.0); }
        case 2u: { uv = vec2<f32>(1.0, 1.0); }
        case 3u: { uv = vec2<f32>(0.0, 0.0); }
        case 4u: { uv = vec2<f32>(1.0, 1.0); }
        default: { uv = vec2<f32>(0.0, 1.0); }
    }
    
    let world_pos = instance.pos + uv * instance.size;
    let screen_pos = world_pos * uniforms.camera_zoom + uniforms.camera_offset;
    
    let ndc_x = (screen_pos.x / uniforms.viewport_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (screen_pos.y / uniforms.viewport_size.y) * 2.0;
    
    out.clip_position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.local_uv = uv;
    out.card_size = instance.size * uniforms.camera_zoom;
    out.selected = instance.selected;
    return out;
}

@fragment
fn fs_card(in: CardVertexOutput) -> @location(0) vec4<f32> {
    // The selection box: a square, translucent area with a thin border.
    if (in.selected > 1.5) {
        let edge = min(in.local_uv * in.card_size, (vec2<f32>(1.0, 1.0) - in.local_uv) * in.card_size);
        if (min(edge.x, edge.y) < 1.0) {
            return vec4<f32>(0.38, 0.65, 0.98, 0.9);
        }
        return vec4<f32>(0.23, 0.51, 0.96, 0.12);
    }

    let p = in.local_uv * in.card_size;
    let half_size = in.card_size * 0.5;
    let pos_from_center = abs(p - half_size);
    let radius = 10.0;
    let q = pos_from_center - (half_size - vec2<f32>(radius, radius));
    let dist = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
    
    if (dist > 0.0) {
        discard;
    }
    
    let border_thickness = select(1.5, 3.0, in.selected > 0.5);
    let is_border = dist > -border_thickness;
    
    let fill_color = vec4<f32>(0.11, 0.14, 0.19, 0.95);
    let default_border = vec4<f32>(0.24, 0.28, 0.38, 1.0);
    let selected_border = vec4<f32>(0.23, 0.51, 0.96, 1.0);
    
    let border_color = select(default_border, selected_border, in.selected > 0.5);
    
    if (is_border) {
        return border_color;
    }
    return fill_color;
}

// Connection Ribbon Pass
struct ConnectionVertexInput {
    @location(0) world_pos: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct ConnectionVertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_connection(in: ConnectionVertexInput) -> ConnectionVertexOutput {
    var out: ConnectionVertexOutput;
    let screen_pos = in.world_pos * uniforms.camera_zoom + uniforms.camera_offset;
    let ndc_x = (screen_pos.x / uniforms.viewport_size.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (screen_pos.y / uniforms.viewport_size.y) * 2.0;
    out.clip_position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_connection(in: ConnectionVertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
