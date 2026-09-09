# Use WebGPU geometry with HTML labels and a keyboard-accessible list

The initial MVP renders card geometry, prerequisite connections, the grid, and selection through WebGPU, while labels use HTML overlays positioned from engine data and text editing uses React UI. This proves editor mechanics without first building an advanced GPU text subsystem, at the cost of possibly needing another label-rendering strategy if benchmarks show the HTML approach cannot handle the target workload.

The canvas editor targets desktop and laptop use with a mouse or trackpad, keyboard, and a browser providing WebGPU. Mobile touch support and a WebGL renderer are deferred. This narrows the initial testing scope at the cost of the canvas being unavailable on some devices.

The application also provides a list of Skills and their Prerequisites. Users can select a Skill and access Tasks, Submissions, and Reviews through keyboard navigation, including when a WebGPU canvas is unavailable. Card-position editing still requires the canvas in the MVP. This provides another route to learning activities, at the cost of keeping the list and canvas representations consistent.

GPU device loss or renderer failure preserves the CPU-side document. The application attempts to recreate the renderer; if recovery fails, it reports the failure, offers another attempt, and keeps the list view available. This requires a dedicated recovery path and temporarily interrupts canvas interaction, while preventing renderer failure alone from discarding the active document.
