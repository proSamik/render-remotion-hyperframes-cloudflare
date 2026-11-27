---
id: estimateprice
title: estimatePrice()
crumb: 'Cloudflare Containers API'
---

# estimatePrice()

Calculates the cost of a render at Cloudflare's list prices, in USD. The counterpart of
[`estimatePrice()`](https://www.remotion.dev/docs/lambda/estimateprice).

Cloudflare has two meters where Lambda has one: CPU is billed by use, memory and disk by instance time.

## Example

```ts
import { estimatePrice, estimatePriceForDuration } from 'remotion-cloudflare-containers/client';

estimatePrice({ cpuSeconds: 186.3, instanceSeconds: 102.6 }); // 0.006948

// a planning figure from our measurements
estimatePriceForDuration({ durationInSeconds: 60, content: 'motion-graphics' }); // 0.019668
```

## Arguments

### `cpuSeconds`

Active vCPU seconds, summed over instances. `getRenderProgress().costs.cpuSeconds` reports it.

### `instanceSeconds`

Seconds the instances existed, summed. `getRenderProgress().costs.instanceSeconds`.

### `instanceType?`

`'lite'`, `'basic'`, `'standard-1'` to `'standard-4'`. Default `'standard-4'`.

## Return value

A number. Not included: amounts included in the Workers Paid plan, egress, R2, Worker and Durable Object requests,
the Remotion licence.

## estimatePriceForDuration()

`{ durationInSeconds, content }` where `content` is one of `'footage-with-captions'`, `'motion-graphics'`,
`'webgl-angle-egl'`, `'webgl-swangle'`. It multiplies with what we measured in November 2026 on `standard-4`
(`MEASURED_PER_OUTPUT_SECOND`). Your content will differ. See [Cost](cost.md).

## See also

- [Source code](../../packages/cloudflare-containers/src/api/estimate-price.ts)
