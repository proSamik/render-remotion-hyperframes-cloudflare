/**
 * Shared types of the render coordinator, the container task server and the engines.
 * Nothing here knows about Remotion or HyperFrames: an engine turns a `RenderOptions` object into files.
 */

/** What a composition is: answered by the engine inside a container (`POST /plan`). */
export type Plan = {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  /** false: the engine can only render the whole range in one process (HyperFrames CLI). */
  chunkable: boolean;
};

/** Engine options. Passed through untouched by the coordinator. */
export type RenderOptions = Record<string, unknown> & {
  /** 'media' (default) or 'still'. */
  type?: 'media' | 'still';
  /** Inclusive frame range of the whole export, like Remotion's `frameRange`. */
  frameRange?: [number, number] | null;
};

/** How the coordinator spreads one render over instances. */
export type FleetOptions = {
  /** Render instances for this job. Default 1. */
  instances?: number;
  /** Render processes per instance, one browser tab each. Default 3 (measured best on 4 vCPU), use 2 for WebGL. */
  processesPerInstance?: number;
  /** Chunk length in frames. Default: frames / (instances * processesPerInstance), at least `minFramesPerChunk`. */
  framesPerChunk?: number | null;
  /** Extra attempts per chunk after the first. Default 2. */
  maxRetries?: number;
  /** Seconds a chunk may run before it is abandoned and re-queued. Default: max(180, frames / 1.5 fps). */
  chunkDeadlineSeconds?: number | null;
  /** Start a second copy of a chunk that runs far longer than the others when a slot is free. Default true. */
  duplicateStragglers?: boolean;
};

export type JobRequest = { render: RenderOptions; fleet?: FleetOptions };

export type FileInfo = { name: string; bytes: number; sha256: string };

export type TaskKind = 'chunk' | 'single' | 'still' | 'stitch';

/** A unit of work for one container process. */
export type TaskRequest = {
  id: string;
  jobId: string;
  kind: TaskKind;
  render: RenderOptions;
  plan: Plan;
  /** chunk/single: range to render, end exclusive. */
  startFrame?: number;
  endFrame?: number;
  /** First frame of the WHOLE export; the same for every chunk. */
  compositionStart?: number;
  chunkIndex?: number;
  /** stitch: chunk grid. */
  framesPerChunk?: number;
  chunkCount?: number;
  /** Concurrent render processes on this instance (lets the engine pick tabs per process). */
  processes?: number;
  /** R2 mode: presigned PUT URL per output file name; the container uploads its own results. */
  upload?: Record<string, string>;
  /** R2 mode, stitch: presigned GET URL per chunk file name. */
  download?: Record<string, string>;
};

export type TaskStatus = {
  id: string;
  kind: TaskKind;
  state: 'running' | 'done' | 'failed';
  framesRendered: number;
  files: FileInfo[];
  error?: string;
  /** Measured inside the instance: wall seconds of the task and busy vCPU seconds of the whole VM meanwhile. */
  wallSeconds?: number;
  cpuSeconds?: number;
  uploaded?: boolean;
};

/** The only two things the coordinator needs from a platform. */
export type Fleet = {
  /** HTTP request to the task server of the instance with this name. The instance is started if needed. */
  fetch(instance: string, path: string, init?: RequestInit): Promise<Response>;
  /** Stops the instance and discards its disk. Must not throw when it is already gone. */
  destroy(instance: string): Promise<void>;
};

/** Optional object storage (R2 through presigned URLs). Without it files travel between instances. */
export type Storage = {
  presignPut(key: string): Promise<string>;
  presignGet(key: string, downloadName?: string): Promise<string>;
};

export type ChunkRun = { instance: string; taskId: string; startedAt: number; framesRendered: number };

export type ChunkState = {
  index: number;
  startFrame: number;
  /** exclusive */
  endFrame: number;
  state: 'pending' | 'running' | 'rendered' | 'stored';
  attempts: number;
  runs: ChunkRun[];
  /** Where the rendered files are (instance name) and what they must hash to. */
  instance?: string;
  files?: FileInfo[];
  renderSeconds?: number;
  transferAttempts: number;
};

export type InstanceState = {
  name: string;
  startedAt: number;
  /** First successful answer. */
  readyAt?: number;
  /** Consecutive polls without an answer. */
  misses: number;
  gone?: boolean;
  wallSeconds: number;
  cpuSeconds: number;
};

export type JobError = { at: number; chunk?: number; instance?: string; message: string; fatal: boolean };

export type JobState = {
  id: string;
  request: JobRequest;
  phase: 'planning' | 'rendering' | 'stitching' | 'done' | 'failed';
  createdAt: number;
  finishedAt?: number;
  plan?: Plan;
  single?: boolean;
  usesStorage?: boolean;
  startFrame: number;
  /** exclusive */
  endFrame: number;
  framesPerChunk: number;
  chunks: ChunkState[];
  instances: InstanceState[];
  nextInstance: number;
  stitcher?: string;
  stitchTask?: { id: string; startedAt: number; attempts: number };
  output?: FileInfo & { instance?: string; key?: string };
  errors: JobError[];
  taskCpuSeconds: number;
  taskWallSeconds: number;
};

/** What `GET /renders/<id>` returns. Field names follow Remotion Lambda's getRenderProgress() where the idea is the same. */
export type RenderProgress = {
  renderId: string;
  done: boolean;
  overallProgress: number;
  phase: JobState['phase'];
  framesRendered: number;
  frames: number;
  chunks: { total: number; rendered: number; stored: number; running: number };
  instances: number;
  fatalErrorEncountered: boolean;
  errors: JobError[];
  outputFile: string | null;
  outputSizeInBytes: number | null;
  outputSha256: string | null;
  timeToFinish: number | null;
  costs: { accruedSoFar: number; currency: 'USD'; disclaimer: string; cpuSeconds: number; instanceSeconds: number };
};

/** What an engine (Remotion, HyperFrames, a mix) implements. It runs in its own process, one task per process. */
export type Engine = {
  /** Size, frame rate and length of what `render` describes. */
  plan(render: RenderOptions): Promise<Plan>;
  /** Renders `task` into `dir` and returns the file names it wrote. kind 'chunk': video first, then audio. */
  render(input: { task: TaskRequest; dir: string; onProgress: (framesRendered: number) => void }): Promise<string[]>;
  /** Joins the chunk files in `dir` (`chunk-0000.ts`, `chunk-0000.aac`, ...) and returns the output file name. */
  stitch(input: { task: TaskRequest; dir: string }): Promise<string[]>;
};
