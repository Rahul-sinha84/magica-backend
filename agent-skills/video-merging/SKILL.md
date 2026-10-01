---
name: video-merging
description: How to join several videos into one with the merge_videos tool — collecting the clips in the right order, choosing a transition, and reporting the result.
---

# Video merging

Use this when the user wants to combine, join, stitch or concatenate two or more videos into a single video.

## Collecting the clips

- You need **between 2 and 100** public `https://` video URLs. Use the ones the user gave, or videos generated earlier
  in the conversation (they appear as `[Generated video: <url>]`). Never invent a URL.
- **Order matters**: the clips play in exactly the order you pass them. Keep the order the user gave. If they say
  "put the intro first" or "end with the logo", reorder accordingly. If the order is unclear, ask.
- If the user gives only one video, explain that merging needs at least two and ask for the others.

## Choosing the transition

- `none` (default): straight cuts. Best for clips that already flow into each other, or when the user says nothing.
- `fade`: a short fade between clips. Good for slideshows and calmer edits.
- `dissolve`: one clip blends into the next. Good for scene changes and montages.

Use what the user asks for; otherwise use `none`. One transition applies between every pair of clips.

## After the tool returns

- The merged video is shown automatically. Say how many clips were joined, in what order, and with which transition.
- Merging takes longer for many or long clips; that is normal.
- If the tool fails, explain it with the error you were given. The most common causes are a link that is not a
  public video, or a format the service cannot read; suggest checking or replacing that link.
