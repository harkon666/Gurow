#[cfg(target_arch = "wasm32")]
mod wasm {
    use engine_core::{EditorCommand, EditorEvent, EditorState};
    use renderer_wgpu::WgpuRenderer;
    use std::sync::Arc;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub struct WasmRendererHandle {
        renderer: WgpuRenderer,
    }

    async fn build_renderer_internal(canvas: &web_sys::HtmlCanvasElement) -> Result<WgpuRenderer, JsValue> {
        let width = canvas.width();
        let height = canvas.height();

        let instance = wgpu::Instance::default();
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|e| JsValue::from_str(&format!("Failed to create surface: {:?}", e)))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| JsValue::from_str("No suitable WebGPU adapter found"))?;

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("Editor WebGPU Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to request device: {:?}", e)))?;

        let device = Arc::new(device);
        let queue = Arc::new(queue);

        let renderer = WgpuRenderer::new(surface, &adapter, device, queue, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;

        Ok(renderer)
    }

    #[wasm_bindgen]
    pub async fn create_renderer_handle(canvas: web_sys::HtmlCanvasElement) -> Result<WasmRendererHandle, JsValue> {
        console_error_panic_hook::set_once();
        let renderer = build_renderer_internal(&canvas).await?;
        Ok(WasmRendererHandle { renderer })
    }

    #[wasm_bindgen]
    pub struct WasmEditor {
        state: EditorState,
        renderer: Option<WgpuRenderer>,
        canvas: Option<web_sys::HtmlCanvasElement>,
    }

    impl WasmEditor {
        fn render_and_serialize_events(&mut self, mut events: Vec<EditorEvent>) -> Result<String, JsValue> {
            if let Some(renderer) = &mut self.renderer {
                if let Err(err) = renderer.render(&self.state) {
                    events.push(EditorEvent::GpuError {
                        message: format!("Renderer error: {}", err),
                    });
                }
            }
            serde_json::to_string(&events)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize events: {:?}", e)))
        }
    }

    #[wasm_bindgen]
    impl WasmEditor {
        pub async fn create(canvas: web_sys::HtmlCanvasElement) -> Result<WasmEditor, JsValue> {
            console_error_panic_hook::set_once();

            let width = canvas.width();
            let height = canvas.height();

            let mut renderer = build_renderer_internal(&canvas).await?;

            let mut state = EditorState::new();
            state.set_viewport(width as f32, height as f32);

            renderer
                .render(&state)
                .map_err(|e| JsValue::from_str(&format!("Initial render failed: {}", e)))?;

            Ok(WasmEditor {
                state,
                renderer: Some(renderer),
                canvas: Some(canvas),
            })
        }

        pub fn create_headless() -> WasmEditor {
            console_error_panic_hook::set_once();
            let mut state = EditorState::new();
            state.set_viewport(800.0, 600.0);
            WasmEditor {
                state,
                renderer: None,
                canvas: None,
            }
        }

        pub fn attach_renderer(&mut self, handle: WasmRendererHandle, canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
            let mut renderer = handle.renderer;
            renderer
                .render(&self.state)
                .map_err(|e| JsValue::from_str(&format!("Render failed upon attachment: {}", e)))?;

            self.renderer = Some(renderer);
            self.canvas = Some(canvas);
            Ok(())
        }

        pub fn simulate_device_loss(&mut self) {
            self.renderer = None;
        }

        pub fn is_renderer_active(&self) -> bool {
            self.renderer.is_some()
        }

        pub fn dispatch_command(&mut self, json_str: &str) -> Result<String, JsValue> {
            let cmd: EditorCommand = serde_json::from_str(json_str)
                .map_err(|e| JsValue::from_str(&format!("Failed to parse command: {:?}", e)))?;
            if let EditorCommand::ResizeViewport { .. } = &cmd {
                // The browser sets physical backing dimensions before dispatch.
                // Command dimensions stay in CSS pixels for camera and hit testing.
                if let (Some(renderer), Some(canvas)) = (&mut self.renderer, &self.canvas) {
                    renderer.resize(canvas.width(), canvas.height());
                }
            }
            let events = self.state.apply_command(cmd);
            self.render_and_serialize_events(events)
        }
    }
}


#[cfg(target_arch = "wasm32")]
pub use wasm::*;
