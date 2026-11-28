/**
 * The short form of a render request, for curl and for people who do not want to learn the fleet options:
 *
 *   { "engine": "remotion", "composition": "Shapes", "inputProps": {...}, "range": [0, 89], "quality": "720p", "tier": "standard" }
 *   { "engine": "hyperframes", "composition": "composition", "variables": {...}, "quality": "480p", "tier": "fast" }
 *   { "engine": "mixed", "composition": "Mixed", "tier": "economy" }
 *
 * It is turned into the full `{ render, fleet }` request (types.ts) that the coordinator takes. The full form keeps
 * working; a body is the short form when it has `engine` at the top level. Pure functions, unit-tested.
 */
import { normalizeQuality } from './resolution.ts';
import type { FleetOptions, JobRequest, RenderOptions } from './types.ts';

export const ENGINES = ['remotion', 'hyperframes', 'mixed'] as const;
export type EngineName = (typeof ENGINES)[number];

/**
 * Speed tiers: how many instances one render may use. More instances finish sooner and cost about the same CPU, plus
 * a little more start-up and memory time. Always capped by MAX_INSTANCES_PER_RENDER.
 */
export const TIERS = { economy: 1, standard: 2, fast: 4 } as const;
export type TierName = keyof typeof TIERS;

export type SimpleRenderRequest = {
  engine: EngineName;
  /** Remotion and mixed: the composition id. HyperFrames: the project folder in the image. */
  composition?: string;
  /** Remotion and mixed: input props. */
  inputProps?: Record<string, unknown>;
  /** HyperFrames: values for `data-composition-variables`. */
  variables?: Record<string, unknown>;
  /** First and last frame, both included. Default: the whole composition. */
  range?: [number, number];
  /** Output size: 360p, 480p, 720p, 1080p, 1440p, 2160p (2k, 4k), or "composition" (default). */
  quality?: string;
  /** economy (1 instance), standard (2, default), fast (4). */
  tier?: TierName;
  /** HyperFrames only: its encoder preset (draft, looks, standard, high, delivery). Default looks. */
  preset?: string;
  /** HyperFrames only: mp4 (default, split over instances), webm or mov (one piece). */
  format?: 'mp4' | 'webm' | 'mov';
};

/** Default composition per engine: the ones the deployable image contains. */
export const DEFAULT_COMPOSITION: Record<EngineName, string> = { remotion: 'Shapes', hyperframes: 'composition', mixed: 'Mixed' };

export const isSimpleRequest = (body: unknown): body is SimpleRenderRequest => typeof body === 'object' && body !== null && 'engine' in body;

const plain = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The full request, or the reason the body is refused. */
export function toJobRequest(body: SimpleRenderRequest, maxInstances: number): { request: JobRequest } | { error: string } {
  const engine = body.engine;
  if (!(ENGINES as readonly string[]).includes(engine)) return { error: `engine must be one of ${ENGINES.join(', ')}` };
  const composition = body.composition ?? DEFAULT_COMPOSITION[engine];
  if (typeof composition !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(composition)) return { error: 'composition must be a name' };
  const quality = normalizeQuality(body.quality);
  if (!quality) return { error: 'quality must be one of 360p, 480p, 720p, 1080p, 1440p, 2160p, 2k, 4k, composition' };
  const tier = body.tier ?? 'standard';
  if (!(tier in TIERS)) return { error: `tier must be one of ${Object.keys(TIERS).join(', ')}` };
  let frameRange: [number, number] | null = null;
  if (body.range !== undefined) {
    const [first, last] = Array.isArray(body.range) ? body.range : [];
    if (!Number.isInteger(first) || !Number.isInteger(last) || first! < 0 || last! < first!) return { error: 'range must be [first frame, last frame], both included' };
    frameRange = [first!, last!];
  }
  if (body.inputProps !== undefined && !plain(body.inputProps)) return { error: 'inputProps must be an object' };
  if (body.variables !== undefined && !plain(body.variables)) return { error: 'variables must be an object' };

  const fleet: FleetOptions = { instances: Math.max(1, Math.min(TIERS[tier as TierName], maxInstances)) };
  let render: RenderOptions;
  if (engine === 'hyperframes') {
    render = {
      engine, project: composition, resolution: quality,
      ...(body.preset ? { quality: body.preset } : {}), ...(body.format ? { format: body.format } : {}),
      ...(body.variables ? { variables: body.variables } : {}), ...(frameRange ? { frameRange } : {}),
    };
    // Chunk lengths follow the cost of each range (heavy scenes get shorter chunks); see docs/hyperframes-split.md.
    fleet.chunks = 'auto';
  } else {
    render = { engine, composition, quality, inputProps: body.inputProps ?? {}, ...(frameRange ? { frameRange } : {}) };
  }
  return { request: { render, fleet } };
}
