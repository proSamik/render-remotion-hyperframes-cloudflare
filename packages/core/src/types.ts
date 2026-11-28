/**
 * Shared types of the render coordinator, the container task server and the engines.
 * Nothing here knows about Remotion or HyperFrames: an engine turns a `RenderOptions` object into files.
 */
import type { Segment } from './planner.ts';

/** What a composition is: answered by the engine inside a container (`POST /plan`). */
export type Plan = {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  /** false: the engine can only render the whole range in one process (a HyperFrames format other than MP4). */
  chunkable: boolean;
  /**
   * Suffixes of the files one chunk run writes, video first: `<outputBase><suffix>`. Default `['.ts', '.aac']`
   * (Remotion). The coordinator presigns exactly these names and refuses a run that brings fewer files.
   */
  chunkFiles?: string[];
  /**
   * true: the engine's join takes chunks of different lengths (HyperFrames: every chunk carries absolute timestamps
   * and the sound is mixed once for the whole timeline). Then `fleet.chunks: 'auto'` may cut heavy ranges smaller.
   * Remotion's join needs equal chunks (except the last), so it leaves this unset.
   */
  variableChunks?: boolean;
  /** Frame ranges and what a frame there costs to render (planner.ts), as far as the engine can tell without a browser. */
  segments?: Segment[];
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
  /**
   * Instead of `framesPerChunk`: a number of chunks (equal lengths), or 'auto' for `planRanges()` in planner.ts:
   * one chunk per render process, bounded by `chunkSeconds`, and, when the engine accepts chunks of different lengths
   * (`Plan.variableChunks`), chunks of equal cost: shorter over heavy ranges (`Plan.segments`).
   */
  chunks?: number | 'auto' | null;
  /** Bounds for 'auto', in seconds of video. Defaults: min 2, max 30; `heavyMax` caps the heavy seconds in one chunk. */
  chunkSeconds?: { min?: number; max?: number; heavyMax?: number } | null;
  /** For 'auto' with variable chunks: cost of a frame per class against a light one. Default light 1, gl 1.5, heavy 4. */
  costWeights?: { gl?: number; heavy?: number } | null;
  /** Extra attempts per chunk after the first. Default 2. */
  maxRetries?: number;
  /** Seconds a chunk may run before it is abandoned and re-queued. Default: max(180, frames / 1.5 fps). */
  chunkDeadlineSeconds?: number | null;
  /**
   * Hedging: start a second run of a chunk that is measurably slow (see `hedge()` in coordinator.ts) when nothing is
   * queued and a slot on another instance is free. Default true.
   */
  duplicateStragglers?: boolean;
  /** At most this share of the chunks gets a second run, rounded up. Default 0.05. */
  maxHedgeShare?: number;
  /**
   * How the chunks are joined. 'combine' (default): the engine's own join with every chunk on disk.
   * 'stream': chunks are fed through a pipe in order and deleted behind it; the output is an MP4 on disk.
   * 'stream-fmp4': the same with a fragmented MP4 that is uploaded while it is written (needs storage to pay off).
   */
  stitch?: StitchMode;
};

export type StitchMode = 'combine' | 'stream' | 'stream-fmp4';

export type JobRequest = { render: RenderOptions; fleet?: FleetOptions };

/** `md5` is what S3 and R2 answer as the ETag of a single PUT: an upload over a presigned URL is checked against it. */
export type FileInfo = { name: string; bytes: number; sha256: string; md5?: string };

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
  /** Which run of the chunk this is, from 1. A retry or a hedge is a new run. */
  run?: number;
  /**
   * chunk: base name of the files this run writes (`chunk-0003-r2` -> `.ts` and `.aac`). Every run has its own, on
   * disk and in object storage, so a run that finishes late can never overwrite the files of the run that won.
   */
  outputBase?: string;
  /** stitch: chunk grid. */
  framesPerChunk?: number;
  chunkCount?: number;
  /** stitch: the files of the run that won, per chunk, video first, with the chunk's frames (end exclusive). Sizes and hashes are checked before the join. */
  chunks?: { index: number; files: FileInfo[]; startFrame?: number; endFrame?: number }[];
  stitch?: StitchMode;
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
  /**
   * Measured inside the instance: wall seconds of the task and busy vCPU seconds of the WHOLE VM meanwhile. Two tasks
   * that share an instance each include the other's CPU, so never add these up for a bill: use the instance's own
   * counter (`cpuSeconds` of `GET /tasks`), as the coordinator does.
   */
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

export type ChunkRun = {
  instance: string; taskId: string; startedAt: number; framesRendered: number;
  /** Run number of the chunk, from 1. */
  run: number;
  hedge?: boolean;
  /** When the frame count last changed, and when it first left 0. */
  progressAt: number;
  firstFrameAt?: number;
};

export type ChunkState = {
  index: number;
  startFrame: number;
  /** exclusive */
  endFrame: number;
  state: 'pending' | 'running' | 'rendered' | 'stored';
  /** Runs that failed by the chunk's own fault (a render error, a deadline). Limited by `maxRetries`. */
  attempts: number;
  /** Runs lost with their instance (a restart). Not the chunk's fault: counted apart, with a higher limit. */
  lost?: number;
  /** Runs started so far; the next run is `runsStarted + 1`. */
  runsStarted?: number;
  hedged?: boolean;
  runs: ChunkRun[];
  /** The run whose files were kept. */
  run?: number;
  /** Where the rendered files are (instance name) and what they must hash to. */
  instance?: string;
  files?: FileInfo[];
  renderSeconds?: number;
  /** Seconds to the first frame and frames per second after it, as the coordinator saw them. They feed the hedge rule. */
  firstFrameSeconds?: number;
  fps?: number;
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
  /** Busy vCPU seconds of this instance: the sum of the increases of its own counter. Survives a counter that restarts. */
  cpuSeconds: number;
  /** The counter as last read. */
  cpuCounter?: number;
};

/** What happened, as a fixed word: stable enough to group by in an error tracker (see events.ts). */
export type EventKind =
  | 'plan_error' | 'instance_start_failed' | 'instance_unresponsive' | 'instance_restarted'
  | 'chunk_failed' | 'chunk_deadline' | 'chunk_hung' | 'checksum_mismatch' | 'transfer_error' | 'stitch_error'
  | 'hedge_started' | 'hedge_won' | 'coordinator_error' | 'job_failed' | 'job_cancelled';

/** One entry of `errors` in the progress. Recovered problems are listed too (`fatal: false`). */
export type JobError = { at: number; kind?: EventKind; chunk?: number; attempt?: number; instance?: string; message: string; fatal: boolean };

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
  stitchTask?: { id: string; startedAt: number; attempts: number; outputKey?: string };
  stitchAttempts?: number;
  stitchersLost?: number;
  planFailures?: number;
  hedges?: number;
  hedgesWon?: number;
  /** The highest `overallProgress` reported so far: the number never goes back. */
  progressHigh?: number;
  output?: FileInfo & { instance?: string; key?: string };
  errors: JobError[];
  /** Sums over finished tasks, for statistics only. `taskCpuSeconds` counts shared instances more than once. */
  taskCpuSeconds: number;
  taskWallSeconds: number;
};

/** What `GET /renders/<id>` returns. Field names follow Remotion Lambda's getRenderProgress() where the idea is the same. */
export type RenderProgress = {
  renderId: string;
  done: boolean;
  overallProgress: number;
  /** overallProgress x 100, whole number. */
  percent: number;
  phase: JobState['phase'];
  framesRendered: number;
  frames: number;
  chunks: { total: number; rendered: number; stored: number; running: number };
  /** Second runs of slow chunks: how many were started and how many finished first. */
  hedges: { started: number; won: number };
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
  /**
   * Joins the chunks and returns the output file name. The files are named in `task.chunks` (video first, then audio).
   * `task.stitch` 'combine': every file is already in `dir`. 'stream' / 'stream-fmp4': `chunks.ready(index)` resolves
   * when the files of that chunk are in `dir` and verified, `chunks.release(index)` deletes them; with 'stream-fmp4'
   * and `output` the engine pipes the file into `output.write()` instead of writing it to `dir`.
   */
  stitch(input: { task: TaskRequest; dir: string; chunks?: ChunkFeed; output?: StreamOutput }): Promise<string[]>;
};

/** Chunk files arriving in order on the stitcher (chunk-feed.ts). */
export type ChunkFeed = { ready(index: number): Promise<void>; release(index: number): Promise<void> };
/** Where a streamed output goes (transfer.ts): the engine never sees a URL. */
export type StreamOutput = { name: string; write(stream: AsyncIterable<Uint8Array>): Promise<void> };
