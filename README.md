# emojili-web

The web client for **Emojili Pub Round** — scan a room's QR code with any phone
camera (no app install) and it opens here, joins the same Supabase room over
realtime, and plays with the identical on-device hashed grading as the iOS app.

Static site (no build step). Served via GitHub Pages from `main`. Portable to
Cloudflare Pages later — just point it at this repo.

- `index.html` — shell
- `style.css` — mirrors the iOS "Clean & Bold" palette
- `app.js` — join / realtime / grading, mirrors `PubRoundSession` + `RoomPlayView`

Room code arrives via the URL hash: `…/#ABCDE`.
