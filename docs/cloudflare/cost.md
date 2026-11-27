---
id: cost
title: Cost
crumb: 'Cloudflare Containers'
---

# Cost

A render costs

```
cpuSeconds x $0.000020  +  instanceSeconds x $0.0000314        (standard-4, list price, 2026-11-27)
```

CPU is billed for what is used. Memory and disk are billed for as long as an instance exists.
[`estimatePrice()`](estimateprice.md) computes this, and [`getRenderProgress()`](getrenderprogress.md) reports both
inputs for every render.

## Examples

Measured in November 2026 on `standard-4`, 1920x1080 at 30 fps, Remotion 4.0.530. Your numbers will differ.

| Video | Cost | Per output minute |
| --- | --- | --- |
| Light motion graphics with sound, 60 s, 4 instances (this repository's `Shapes`) | $0.0069 | $0.007 |
| Camera footage with captions | | $0.011 |
| Camera footage, 10 minutes on 8 instances | $0.074 to $0.088 | $0.007 to $0.009 |
| Motion graphics, four animated templates | | $0.020 |
| A 3D model in WebGL on Mesa llvmpipe | | $0.044 |
| The same on SwiftShader | | $0.127 |
| One still | $0.0003 | |

The method, everything that is left out, and how to measure your own content: [costs.md](../costs.md).

## For comparison

Remotion publishes Lambda examples (https://www.remotion.dev/docs/lambda/cost-example; 2048 MB, us-east-1,
v4.0.381, compute only): a 1-minute video $0.017 warm, a 10-minute HD video $0.103 warm. Those are different videos
on a different platform, so read the two tables side by side with care. We did not run anything on AWS.

## What Remotion charges

Nothing for the software route you choose, and the same licence either way. Companies with more than 3 employees
need a company licence; automated rendering is $0.01 per render with a $100 monthly minimum
(https://www.remotion.dev/docs/license/pricing). For a short video that fee is larger than the compute. Whether a
self-hosted render made of many `renderMedia()` calls and one `combineChunks()` counts as one render is not stated
on the pages we read. Ask Remotion if it matters to you.

## Keeping it low

1. Delete each render when you have the file. An instance that waits costs $0.113 per hour.
2. Do not use `swangle` for content without WebGL.
3. Fill the instance: 3 processes for normal content.
4. Avoid large CSS blurs, shadows and filters: without a GPU they are computed on the CPU for every frame.
5. Longer videos are cheaper per minute than short ones, because starts are a fixed cost.
