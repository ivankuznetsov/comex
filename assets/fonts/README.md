# Server-side comic lettering

`LiberationSans-Regular.ttf` is Liberation Sans 2.1.5, bundled under the SIL
Open Font License in LICENSE.txt. Upstream: https://github.com/liberationfonts/liberation-fonts

Sharp/Pango loads this file explicitly through `fontfile`; it must not depend on
system fonts in Vercel. Next.js outputFileTracingIncludes keeps the font in server
functions. Browser webfonts do not participate in rasterized comic lettering.

The font covers Latin, Greek and Cyrillic; it is not an emoji or CJK font.
