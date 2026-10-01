---
name: image-generation
description: How to create a new image from a text description with the gpt_image_2 tool (text mode) — writing the prompt, picking size and quality, and presenting the result.
---

# Image generation

Use this when the user asks for a new picture, illustration, photo, logo, icon, poster, or any image that does not
start from an existing image. To change an image the user already has (or one you generated earlier), use the
image-editing skill instead.

## Before calling the tool

1. Make sure you know **what** to draw. If the request is too vague to produce something useful ("make an image"),
   ask one short question first. If it is clear enough, do not ask: generate.
2. Turn the request into a single, concrete prompt (at most 4,000 characters):
   - **Subject** first: who or what, doing what.
   - **Setting**: place, time of day, weather, background.
   - **Style**: photo, flat illustration, watercolor, 3D render, pixel art, line drawing…
   - **Composition**: close-up, wide shot, centered, from above.
   - **Lighting and colour**: soft daylight, neon, warm palette, black and white.
   - Any **text** that must appear in the image, in quotes, exactly as it should read.
3. Keep the user's own words for the important parts. Do not add brands, real people or content they did not ask for.

## Choosing the options

- **mode**: `text` (a new image).
- **size**: use what the user asked for; otherwise pick by shape.
  - Square (default, icons, avatars, social posts): `1024x1024`.
  - Landscape (banners, desktop wallpapers, scenes): `1536x1024`, or `2048x1152` for wide.
  - Portrait (phone wallpapers, posters, stories): `1024x1536`.
  - Very large (`2048x2048`, `3840x2160`, `2160x3840`) only when the user asks for high resolution: they are slower
    and cost more.
- **quality**: `medium` unless the user asks for the best quality (`high`) or a quick draft (`low`). High quality is
  noticeably slower — generation can take a minute or two even at low quality.
- **background**: `transparent` only when the user wants a cut-out (logo, sticker, icon on no background); otherwise
  leave it on auto.
- **n** (number of images): 1, unless the user asks for options or variations (up to 4).
- **output format**: PNG unless the user asks for JPEG or WebP (transparent backgrounds need PNG or WebP).

## After the tool returns

- The image is shown to the user automatically. Do not paste the URL into your reply unless they ask for the link.
- Reply in one or two sentences: what you made and one offer to adjust it (style, colours, crop, a variation).
- If the tool fails, say so plainly using the error you were given, and suggest one concrete next step (try again, a
  simpler prompt, a different size). Do not invent a result.
- If the user asks for changes to the image you just made, switch to the image-editing skill and pass that image.
