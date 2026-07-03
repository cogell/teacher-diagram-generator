# Visualization Principles

Distilled from Edward Tufte. Use as design rules and as judging criteria.

## Ink

- Maximize data-ink. Every mark should encode information.
- Erase non-data ink: borders, backgrounds, boxes, heavy gridlines.
- Erase redundant data-ink: don't say the same thing twice (bar + label + axis tick).
- No chartjunk: no 3D, gradients, shadows, decorative icons, moiré fills.

## Color & Contrast

- Grayscale first. Add color only to encode meaning, never to decorate.
- Use the smallest effective difference: light gray vs. black beats red vs. blue.
- Layer with subtlety — muted context, strong foreground data.

## Labels

- Label data directly, on or next to the mark. Avoid legends when possible.
- No abbreviations that force decoding. Write words.
- Annotations belong in the graphic, not in a caption below it.

## Integrity

- Visual size must be proportional to the value (lie factor = 1).
- Don't truncate axes to exaggerate. Don't use area for 1D quantities.
- Show variation in data, not variation in design.

## Density & Comparison

- Don't dumb down. High information density is a feature.
- Small multiples: repeat the same small chart with shared axes to enable comparison.
- Reward both a glance (macro shape) and close reading (micro detail).

## Layout

- Content decides structure, not the template.
- Whitespace separates; lines rarely need to.
- Align to a grid; let position carry meaning.

## Quick test

1. Remove a mark. Did the graphic lose information? If not, it was junk.
2. Is anything colored, bold, or large without a reason? Mute it.
3. Can a reader get the numbers back out? If not, integrity failed.
