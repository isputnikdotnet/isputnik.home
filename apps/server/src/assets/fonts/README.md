# Bundled title-card fonts

The faces the slideshow movie's title card can be set in (`slideshow-title-card.ts`
`CARD_FONT_FILES`). Every face must pass two checks before it ships here: full
Cyrillic coverage, and looking right under the drawer's unshaped
character-by-character layout — a face that fails is replaced, never special-cased.
(PT Serif failed the second check — its '6' glyph rendered broken through
opentype.js — which is why the serif style is DejaVu Serif.)

| File | Style | Source | License |
| --- | --- | --- | --- |
| `DejaVuSans.ttf` | classic | dejavu-fonts.github.io (v2.37) | Bitstream Vera / public-domain additions |
| `DejaVuSans-Bold.ttf` | bold | dejavu-fonts.github.io (v2.37) | Bitstream Vera / public-domain additions |
| `DejaVuSerif.ttf` | serif | dejavu-fonts.github.io (v2.37) | Bitstream Vera / public-domain additions |
| `MarckScript-Regular.ttf` | script | github.com/google/fonts `ofl/marckscript` | SIL Open Font License 1.1 |
| `PTMono-Regular.ttf` | typewriter | github.com/google/fonts `ofl/ptmono` (PTM55FT) | SIL Open Font License 1.1 |

Both licenses permit bundling and redistribution with the app. The web app carries
copies of the same files under `apps/web/public/fonts/` so the editor's font-style
chips can preview each face; keep the two directories in sync.
