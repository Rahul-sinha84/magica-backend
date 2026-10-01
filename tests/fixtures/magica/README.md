# Magica API fixtures

Real responses captured from the Magica API on 2026-10-01 (models, input schemas, pricing, and four completed runs at
the cheapest settings), used by the fake Magica server in tests. No API key or auth header is stored here.

- `run.*.completed.json` are real. `run.*.queued.json` / `run.*.running.json` are the same runs with the status set back
  (output removed), and `run.gpt_text.failed.json` is a constructed failure using the documented `error` / `userMessage`
  fields.
- `error.401.json` is the real body for a wrong key; `error.429.json` and `error.404.json` follow the documented envelope.

Output shapes differ per model: GPT Image 2 returns `output.result` (URL list) with `output.resultMetadata`; Crop Image
returns `output.image_url` with `width` / `height`; Merge Videos returns `output.video_url` with `mimeType`, `duration`,
`width`, `height`. Every run reports `creditUsed` in microcredits.
