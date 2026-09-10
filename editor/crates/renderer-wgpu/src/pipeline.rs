use bytemuck::{Pod, Zeroable};
use engine_core::EditorState;
use std::sync::Arc;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct Uniforms {
    pub camera_offset: [f32; 2],
    pub viewport_size: [f32; 2],
    pub camera_zoom: f32,
    pub _pad0: f32,
    pub _pad1: [f32; 2],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct CardInstanceRaw {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub selected: f32,
    pub _pad: f32,
}

impl CardInstanceRaw {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<CardInstanceRaw>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: (std::mem::size_of::<[f32; 2]>() * 2) as wgpu::BufferAddress,
                    shader_location: 2,
                    format: wgpu::VertexFormat::Float32,
                },
            ],
        }
    }
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct ConnectionVertexRaw {
    pub world_pos: [f32; 2],
    pub color: [f32; 4],
}

impl ConnectionVertexRaw {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<ConnectionVertexRaw>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x4,
                },
            ],
        }
    }
}

pub struct WgpuRenderer {
    pub surface: wgpu::Surface<'static>,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub config: wgpu::SurfaceConfiguration,
    pub uniform_buffer: wgpu::Buffer,
    pub uniform_bind_group: wgpu::BindGroup,
    pub card_pipeline: wgpu::RenderPipeline,
    pub card_buffer: wgpu::Buffer,
    pub card_buffer_capacity: usize,
    pub connection_pipeline: wgpu::RenderPipeline,
    pub connection_buffer: wgpu::Buffer,
    pub connection_buffer_capacity: usize,
}

impl WgpuRenderer {
    pub async fn new(
        surface: wgpu::Surface<'static>,
        adapter: &wgpu::Adapter,
        device: Arc<wgpu::Device>,
        queue: Arc<wgpu::Queue>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let surface_caps = surface.get_capabilities(adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(surface_caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: surface_caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editor Card Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let initial_uniforms = Uniforms {
            camera_offset: [0.0, 0.0],
            viewport_size: [width as f32, height as f32],
            camera_zoom: 1.0,
            _pad0: 0.0,
            _pad1: [0.0, 0.0],
        };

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer"),
            contents: bytemuck::cast_slice(&[initial_uniforms]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Uniform Bind Group Layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editor Pipeline Layout"),
            bind_group_layouts: &[&uniform_bind_group_layout],
            push_constant_ranges: &[],
        });

        let card_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Card Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_card"),
                buffers: &[CardInstanceRaw::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_card"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let connection_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Connection Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_connection"),
                buffers: &[ConnectionVertexRaw::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_connection"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let card_buffer_capacity = 64;
        let card_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Card Instance Buffer"),
            size: (card_buffer_capacity * std::mem::size_of::<CardInstanceRaw>())
                as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let connection_buffer_capacity = 512;
        let connection_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Connection Vertex Buffer"),
            size: (connection_buffer_capacity * std::mem::size_of::<ConnectionVertexRaw>())
                as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self {
            surface,
            device,
            queue,
            config,
            uniform_buffer,
            uniform_bind_group,
            card_pipeline,
            card_buffer,
            card_buffer_capacity,
            connection_pipeline,
            connection_buffer,
            connection_buffer_capacity,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }

    pub fn render(&mut self, state: &EditorState) -> Result<(), String> {
        let output = match self.surface.get_current_texture() {
            Ok(texture) => texture,
            Err(wgpu::SurfaceError::Lost) => {
                self.resize(self.config.width, self.config.height);
                match self.surface.get_current_texture() {
                    Ok(texture) => texture,
                    Err(_) => {
                        // Surface reconfigured; skip this frame gracefully
                        return Ok(());
                    }
                }
            }
            Err(wgpu::SurfaceError::OutOfMemory) => {
                return Err("WebGPU Out of Memory".into());
            }
            Err(e) => {
                return Err(format!("Surface error: {:?}", e));
            }
        };

        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let uniforms = Uniforms {
            camera_offset: [state.camera.offset_x, state.camera.offset_y],
            viewport_size: [state.viewport_size.width, state.viewport_size.height],
            camera_zoom: state.camera.zoom,
            _pad0: 0.0,
            _pad1: [0.0, 0.0],
        };
        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let mut connection_vertices = Vec::new();
        let connection_color = [0.23, 0.51, 0.96, 0.85];
        for conn in &state.document.connections {
            if let (Some(from_card), Some(to_card)) = (
                state.document.find_card(&conn.from_id),
                state.document.find_card(&conn.to_id),
            ) {
                let p0 = [
                    from_card.position.x + from_card.size.width,
                    from_card.position.y + from_card.size.height * 0.5,
                ];
                let p3 = [
                    to_card.position.x,
                    to_card.position.y + to_card.size.height * 0.5,
                ];
                generate_bezier_connection_mesh(p0, p3, 2.5, connection_color, &mut connection_vertices);
            }
        }

        if connection_vertices.len() > self.connection_buffer_capacity {
            self.connection_buffer_capacity = (connection_vertices.len() * 2).max(512);
            self.connection_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Connection Vertex Buffer"),
                size: (self.connection_buffer_capacity * std::mem::size_of::<ConnectionVertexRaw>())
                    as wgpu::BufferAddress,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }

        if !connection_vertices.is_empty() {
            self.queue.write_buffer(
                &self.connection_buffer,
                0,
                bytemuck::cast_slice(&connection_vertices),
            );
        }

        let card_instances: Vec<CardInstanceRaw> = state
            .cards_with_selection()
            .map(|(c, is_selected)| CardInstanceRaw {
                pos: [c.position.x, c.position.y],
                size: [c.size.width, c.size.height],
                selected: if is_selected { 1.0 } else { 0.0 },
                _pad: 0.0,
            })
            .collect();

        if card_instances.len() > self.card_buffer_capacity {
            self.card_buffer_capacity = (card_instances.len() * 2).max(64);
            self.card_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Card Instance Buffer"),
                size: (self.card_buffer_capacity * std::mem::size_of::<CardInstanceRaw>())
                    as wgpu::BufferAddress,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }

        if !card_instances.is_empty() {
            self.queue.write_buffer(
                &self.card_buffer,
                0,
                bytemuck::cast_slice(&card_instances),
            );
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Render Encoder"),
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Editor Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.07,
                            g: 0.08,
                            b: 0.11,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if !connection_vertices.is_empty() {
                render_pass.set_pipeline(&self.connection_pipeline);
                render_pass.set_bind_group(0, &self.uniform_bind_group, &[]);
                render_pass.set_vertex_buffer(0, self.connection_buffer.slice(..));
                render_pass.draw(0..connection_vertices.len() as u32, 0..1);
            }

            if !card_instances.is_empty() {
                render_pass.set_pipeline(&self.card_pipeline);
                render_pass.set_bind_group(0, &self.uniform_bind_group, &[]);
                render_pass.set_vertex_buffer(0, self.card_buffer.slice(..));
                render_pass.draw(0..6, 0..card_instances.len() as u32);
            }
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}

fn generate_bezier_connection_mesh(
    p0: [f32; 2],
    p3: [f32; 2],
    thickness: f32,
    color: [f32; 4],
    vertices: &mut Vec<ConnectionVertexRaw>,
) {
    let dx = (p3[0] - p0[0]).abs().max(40.0) * 0.5;
    let p1 = [p0[0] + dx, p0[1]];
    let p2 = [p3[0] - dx, p3[1]];

    let segments = 24;
    let half_w = thickness * 0.5;

    let eval_bezier = |t: f32| -> [f32; 2] {
        let one_minus_t = 1.0 - t;
        let c0 = one_minus_t * one_minus_t * one_minus_t;
        let c1 = 3.0 * one_minus_t * one_minus_t * t;
        let c2 = 3.0 * one_minus_t * t * t;
        let c3 = t * t * t;
        [
            c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0],
            c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1],
        ]
    };

    let eval_tangent = |t: f32| -> [f32; 2] {
        let one_minus_t = 1.0 - t;
        let d0 = -3.0 * one_minus_t * one_minus_t;
        let d1 = 3.0 * one_minus_t * one_minus_t - 6.0 * one_minus_t * t;
        let d2 = 6.0 * one_minus_t * t - 3.0 * t * t;
        let d3 = 3.0 * t * t;
        [
            d0 * p0[0] + d1 * p1[0] + d2 * p2[0] + d3 * p3[0],
            d0 * p0[1] + d1 * p1[1] + d2 * p2[1] + d3 * p3[1],
        ]
    };

    let mut prev_left = [0.0, 0.0];
    let mut prev_right = [0.0, 0.0];

    for i in 0..=segments {
        let t = i as f32 / segments as f32;
        let pt = eval_bezier(t);
        let tan = eval_tangent(t);
        let len = (tan[0] * tan[0] + tan[1] * tan[1]).sqrt().max(1e-4);
        let norm = [-tan[1] / len, tan[0] / len];

        let left = [pt[0] + norm[0] * half_w, pt[1] + norm[1] * half_w];
        let right = [pt[0] - norm[0] * half_w, pt[1] - norm[1] * half_w];

        if i > 0 {
            vertices.push(ConnectionVertexRaw { world_pos: prev_left, color });
            vertices.push(ConnectionVertexRaw { world_pos: prev_right, color });
            vertices.push(ConnectionVertexRaw { world_pos: left, color });

            vertices.push(ConnectionVertexRaw { world_pos: left, color });
            vertices.push(ConnectionVertexRaw { world_pos: prev_right, color });
            vertices.push(ConnectionVertexRaw { world_pos: right, color });
        }

        prev_left = left;
        prev_right = right;
    }

    // Directional Arrowhead pointing toward p3
    let end_tan = eval_tangent(1.0);
    let end_len = (end_tan[0] * end_tan[0] + end_tan[1] * end_tan[1]).sqrt().max(1e-4);
    let dir = [end_tan[0] / end_len, end_tan[1] / end_len];
    let norm = [-dir[1], dir[0]];

    let arrow_len = 10.0;
    let arrow_w = 6.0;

    let tip = p3;
    let base_left = [
        tip[0] - dir[0] * arrow_len + norm[0] * arrow_w,
        tip[1] - dir[1] * arrow_len + norm[1] * arrow_w,
    ];
    let base_right = [
        tip[0] - dir[0] * arrow_len - norm[0] * arrow_w,
        tip[1] - dir[1] * arrow_len - norm[1] * arrow_w,
    ];

    vertices.push(ConnectionVertexRaw { world_pos: tip, color });
    vertices.push(ConnectionVertexRaw { world_pos: base_left, color });
    vertices.push(ConnectionVertexRaw { world_pos: base_right, color });
}
