/**
 * Errors as structured events.
 *
 * Every entry of `errors` in the progress has a `kind` from a fixed list, not only a sentence. That is what lets you
 * count them, alert on them and send them to an error tracker: group by kind, not by text. The entries carry ids,
 * indexes and error text only: no file contents, no URLs with a query string, no user data.
 */
import type { EventKind, JobError } from './types.ts';

export type EventLevel = 'info' | 'warning' | 'error';

/** `info`: part of normal work. `warning`: recovered, worth counting. `error`: the render or a file was at risk. */
export const EVENT_LEVELS: Record<EventKind, EventLevel> = {
  hedge_started: 'info', hedge_won: 'info', job_cancelled: 'info',
  plan_error: 'warning', instance_start_failed: 'warning', instance_unresponsive: 'warning', instance_restarted: 'warning',
  chunk_failed: 'warning', chunk_deadline: 'warning', chunk_hung: 'warning', transfer_error: 'warning', coordinator_error: 'warning',
  checksum_mismatch: 'error', stitch_error: 'error', job_failed: 'error',
};

export type TrackerEvent = {
  /** Stable name of what happened. */
  kind: EventKind;
  level: EventLevel;
  /** Events with the same fingerprint are the same problem. The text and the ids are left out on purpose. */
  fingerprint: string;
  message: string;
  timestamp: string;
  properties: { renderId: string; phase?: string; chunk: number | null; attempt: number | null; instance: string | null; fatal: boolean; service: string };
};

/** One `errors` entry in the shape error trackers take: a type to group by, a message, flat properties. */
export function toTrackerEvent(renderId: string, error: JobError, extra: { phase?: string; service?: string } = {}): TrackerEvent {
  const kind: EventKind = error.kind && error.kind in EVENT_LEVELS ? error.kind : error.fatal ? 'job_failed' : 'coordinator_error';
  return {
    kind, level: EVENT_LEVELS[kind], fingerprint: `${kind}:${extra.phase ?? 'render'}`, message: error.message.slice(0, 500), timestamp: new Date(error.at).toISOString(),
    properties: { renderId, ...(extra.phase ? { phase: extra.phase } : {}), chunk: error.chunk ?? null, attempt: error.attempt ?? null, instance: error.instance ?? null, fatal: error.fatal, service: extra.service ?? 'render-service' },
  };
}
