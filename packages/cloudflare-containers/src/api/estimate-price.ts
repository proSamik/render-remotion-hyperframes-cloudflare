import { PRICES } from '../../../core/src/coordinator.ts';

/** Predefined instance types (developers.cloudflare.com/containers/platform/limits, read 2026-11-27). */
export const INSTANCE_TYPES = {
  'lite': { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
  'basic': { vcpu: 1 / 4, memoryGiB: 1, diskGB: 4 },
  'standard-1': { vcpu: 1 / 2, memoryGiB: 4, diskGB: 8 },
  'standard-2': { vcpu: 1, memoryGiB: 6, diskGB: 12 },
  'standard-3': { vcpu: 2, memoryGiB: 8, diskGB: 16 },
  'standard-4': { vcpu: 4, memoryGiB: 12, diskGB: 20 },
} as const;

export type EstimatePriceInput = {
  /** Active CPU seconds, summed over all instances. Cloudflare bills CPU by use. */
  cpuSeconds: number;
  /** Seconds the instances existed, summed. Memory and disk are billed for this whole time. */
  instanceSeconds: number;
  instanceType?: keyof typeof INSTANCE_TYPES;
};

/**
 * Cost of a render at Cloudflare's list prices, in USD, without the amounts included in the Workers Paid plan and
 * without egress. Same idea as estimatePrice() of @remotion/lambda, with Cloudflare's two meters.
 */
export function estimatePrice({ cpuSeconds, instanceSeconds, instanceType = 'standard-4' }: EstimatePriceInput): number {
  const type = INSTANCE_TYPES[instanceType];
  if (!type) throw new TypeError(`Unknown instance type ${instanceType}`);
  if (!(cpuSeconds >= 0) || !(instanceSeconds >= 0)) throw new TypeError('cpuSeconds and instanceSeconds must be zero or more');
  const price = cpuSeconds * PRICES.vcpuSecond + instanceSeconds * (type.memoryGiB * PRICES.gibSecond + type.diskGB * PRICES.diskGbSecond);
  return Math.round(price * 1e6) / 1e6;
}

/**
 * What we measured on standard-4 in November 2026 (Remotion 4.0.530, 1080p30, 3 processes x 1 tab, JPEG quality 90,
 * x264 veryfast): CPU seconds and instance seconds per second of output. Your content will differ; measure it.
 */
export const MEASURED_PER_OUTPUT_SECOND = {
  'footage-with-captions': { cpuSeconds: 6.06, instanceSeconds: 1.8 },
  'motion-graphics': { cpuSeconds: 11.24, instanceSeconds: 3.28 },
  'webgl-angle-egl': { cpuSeconds: 25.52, instanceSeconds: 6.88 },
  'webgl-swangle': { cpuSeconds: 74.86, instanceSeconds: 19.79 },
} as const;

/** A planning figure from the table above: USD for `durationInSeconds` of output of one content type. */
export function estimatePriceForDuration(input: { durationInSeconds: number; content: keyof typeof MEASURED_PER_OUTPUT_SECOND }): number {
  const measured = MEASURED_PER_OUTPUT_SECOND[input.content];
  return estimatePrice({ cpuSeconds: measured.cpuSeconds * input.durationInSeconds, instanceSeconds: measured.instanceSeconds * input.durationInSeconds });
}
