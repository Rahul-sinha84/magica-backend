---
name: image-editing
description: How to change an existing image — editing it from instructions with gpt_image_2 (edit mode) or cropping it with crop_image — including which image to use and how to describe the change.
---

# Image editing

Use this when the user wants to change an image they provided or one generated earlier in this chat: change the
content or style, add or remove something, or cut out part of it (crop).

## Which image

- Use the image the user points to. "This image", "the last one" or "it" means the most recent image in the
  conversation. Earlier generated images appear in the conversation as `[Generated image: <url>]`.
- Only use public `https://` image URLs from the conversation. Never invent a URL. If you cannot tell which image the
  user means, ask.

## Cropping: crop_image

Use cropping when the user only wants a part of the image ("crop to the top half", "cut out the left side", "make it
square") and nothing else should change. It is fast and does not alter any pixels.

Give the crop as **one** of these, never a mix:

- **Percentages of the image** (best when the user speaks in fractions):
  `x`, `y` (top-left corner) and `width`, `height`, each 0–100.
  - Top half: x 0, y 0, width 100, height 50.
  - Bottom half: x 0, y 50, width 100, height 50.
  - Left half: x 0, y 0, width 50, height 100.
  - Centre square of a 3:2 landscape: x 16.67, y 0, width 66.67, height 100.
  - `x + width` and `y + height` must each stay at or below 100.
- **Exact pixels** (when the user gives pixel sizes): `width` and `height` in pixels, optionally `x` and `y`. Without
  `x`/`y`, the crop is centred.

All four values of a rectangle must be given (or, for pixels, at least width and height). If the request is ambiguous
("crop it a bit"), pick a sensible crop and say what you did.

## Changing the image: gpt_image_2 in edit mode

Use edit mode when the content or look must change: new style, different background, add or remove objects, change
colours, time of day, expressions, text in the image.

- **mode**: `edit`, with the image URL(s) to start from.
- **prompt**: describe the change as an instruction, and say what must stay the same.
  - Good: "Turn the scene into night with a starry sky; keep the fox, its pose and the snow unchanged."
  - Weak: "night".
- Size and quality follow the image-generation skill. Keep the original shape unless the user asks for a new one.

## After the tool returns

- The new image is shown automatically. Briefly say what changed, and offer one follow-up.
- If the tool fails, explain it with the error you were given and suggest a concrete fix (a different crop, a clearer
  instruction, try again). Never claim an edit happened when it did not.
