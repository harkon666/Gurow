export interface FixtureTask {
  id: string
  title: string
  description: string
  required: boolean
}

export interface FixtureSkill {
  id: string
  title: string
  outcome: string
  initialPosition: { x: number; y: number }
  tasks: FixtureTask[]
}

export interface LearningPathFixture {
  id: string
  title: string
  description: string
  skills: FixtureSkill[]
}

export const INITIAL_LEARNING_PATH_FIXTURE: LearningPathFixture = {
  id: 'lp-rust-graphics-mvp',
  title: 'High-Performance Graphics with Rust and WebGPU',
  description: 'Master core systems programming, GPU graphics pipelines, and reactive editor architecture.',
  skills: [
    {
      id: 'skill-rust-basics',
      title: 'Rust Fundamentals',
      outcome: 'Understand Rust syntax, type system, and memory safety invariants.',
      initialPosition: { x: 80, y: 100 },
      tasks: [
        {
          id: 'task-rust-toolchain',
          title: 'Setup Toolchain',
          description: 'Install Rust, cargo, and build the first CLI application.',
          required: true,
        },
      ],
    },
    {
      id: 'skill-ownership',
      title: 'Ownership & Borrowing',
      outcome: 'Master Rust lifetimes, borrowing rules, and zero-cost abstractions.',
      initialPosition: { x: 320, y: 100 },
      tasks: [
        {
          id: 'task-memory-arena',
          title: 'Memory Arena Allocator',
          description: 'Implement a memory-safe custom buffer pool.',
          required: true,
        },
      ],
    },
    {
      id: 'skill-wgpu-pipeline',
      title: 'WebGPU Pipeline',
      outcome: 'Initialize WebGPU devices, write WGSL shaders, and submit render passes.',
      initialPosition: { x: 80, y: 260 },
      tasks: [
        {
          id: 'task-render-quads',
          title: 'Draw Instanced Quads',
          description: 'Submit command buffers and render interactive card geometry.',
          required: true,
        },
      ],
    },
    {
      id: 'skill-concurrency',
      title: 'Async & Concurrency',
      outcome: 'Coordinate asynchronous tasks across web workers and browser event loops.',
      initialPosition: { x: 320, y: 260 },
      tasks: [
        {
          id: 'task-worker-channel',
          title: 'Worker Communication',
          description: 'Set up cross-thread message passing with zero serialization overhead.',
          required: false,
        },
      ],
    },
  ],
}
