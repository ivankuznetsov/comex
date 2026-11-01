# Server-side comic lettering

`LiberationSans-Regular.ttf` is Liberation Sans 2.1.5, bundled under the SIL
Open Font License in LICENSE.txt. Upstream: https://github.com/liberationfonts/liberation-fonts

Sharp/Pango loads this file explicitly through `fontfile`; it must not depend on
system fonts in Vercel. Next.js outputFileTracingIncludes keeps the font in server
functions. Browser webfonts do not participate in rasterized comic lettering.

The font covers Latin, Greek and Cyrillic; it is not an emoji or CJK font.

Classic dialogue balloons use `Pangolin-Regular.ttf` (The Pangolin Project Authors / Google Fonts), bundled under SIL OFL in Pangolin-OFL.txt. Source:
https://github.com/google/fonts/tree/main/ofl/pangolin
It covers Latin and Cyrillic. Speaker labels and dialogue are rendered separately,
with pixel-measured wrapping; balloon tails and panel frames stay outside artwork.
