---
id: troubleshooting
title: Troubleshooting
crumb: 'Cloudflare Containers'
---

# Troubleshooting

The symptoms and fixes are collected in one place for all three example types:
[../troubleshooting.md](../troubleshooting.md).

The first thing to read is always `errors` in [`getRenderProgress()`](getrenderprogress.md). The message of the
render process is there, including the browser's stack trace.

To find where a problem starts, render the same composition three ways:

```bash
remotion-cloudflare render MyComp --local                 # processes on your machine
remotion-cloudflare render MyComp --docker=<image>        # the image, on your machine
remotion-cloudflare render MyComp                         # Cloudflare
```
