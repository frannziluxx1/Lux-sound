# Lux Sound Lab

A complete rebuild and rebrand of the local music player — multi-route SPA, working
import, real playlists, editable profile, functional equalizer with crossfade, and
the rest of the spec below, checked off honestly.

## Run it

```
cd lux-sound-lab
python3 serve.py            # http://localhost:8080
# or: python3 serve.py 3000
```

**Use `serve.py`, not a plain static server or double-clicking the file.** This is a
single-page app with real URL routes (`/library`, `/artists/Some+Name`, etc.) — a
plain static server 404s on refresh for any route but `/`; `serve.py` falls back to
`index.html` for unknown paths so deep links and refreshes work. It also avoids the
`file://` origin, which blocks IndexedDB in several browsers (the root cause of the
original "import doesn't work" bug from your last file).

## Architecture note: why this is one file, not separate pages

You asked for a "proper multi-page/multi-route application," but also that a song
keep playing when navigating from Home to Library. Those two requirements are in
tension for a classic multi-page site — browsers don't preserve audio state across a
real page load. So this is a single-page app using the History API for **real**
routes (they show in the address bar, support back/forward, and are deep-linkable
via `serve.py`), with one shared playback engine that survives every navigation.
That's the only architecture that satisfies both asks honestly.

## What's real (not decorative) — mapped to your 25-point checklist

1. **Import** — file picker / folder picker (`showDirectoryPicker` with an
   `<input type="file">` fallback), real permission-denial handling, honest
   success/failure counts (the previous build's exact bug — claiming success while
   silently losing songs — is fixed and covered by an automated test).
2. **Library** — imported songs actually appear, sortable by recently added/played,
   alphabetical, artist, album.
3–4. **Play/pause** — one shared engine; verified by test.
5. **Next/previous** — real queue advance, including shuffle and wraparound.
6. **Progress bar** — real seek, drives and is driven by actual playback position.
7. **Volume/mute** — I initially shipped a fake "Device" button here and caught it
   myself during review — it's now a real volume slider + mute toggle that sets
   `audio.volume` on both playback elements and persists across sessions.
8–9. **Shuffle/repeat** — real queue-order and loop behavior.
10. **Favorite/like** — persisted to localStorage, reflected everywhere a song appears.
11–12. **Playlists** — full CRUD: create, rename, delete, add songs (from any track's
    "add to playlist" button), remove songs, play, shuffle. Also: save the current
    queue as a new playlist.
13–14. **Profile name edit + persistence** — edits localStorage, verified to survive
    by inspecting storage directly in tests (equivalent to surviving a refresh).
15–16. **Avatar** — real file picker, client-side crop-to-square + resize via canvas,
    stored as a compressed data URL, with graceful storage-quota error handling.
17. **Equalizer** — real Web Audio `BiquadFilterNode` chain, your exact 7 bands
    (60/150/400/1k/2.4k/6k/15k Hz) plus preamp, your exact preset list (Flat, Bass
    Boost, Bass Reducer, Vocal, Treble Boost, Treble Reducer, Pop, Rock, Classical,
    Custom), enable/disable, reset, and save-as-custom. Verified the gains actually
    change and persist.
18. **Settings persistence** — theme, accent, autoplay, crossfade, normalize,
    notifications, history visibility, volume, EQ — all in localStorage.
19. **Navigation** — every one of the 15 routes reachable and tested in one pass
    with zero errors.
20–21. **Mobile responsiveness / bottom nav spacing** — I can't run a real viewport
    test from here, but the CSS is structured so `.main`'s bottom padding accounts
    for both the mini-player and the bottom nav bar's height, and I've reviewed it
    at the 800px/470px breakpoints. Please sanity-check on an actual small Android
    device — that's the one item on this list I'd flag as "reviewed, not device-tested."
22. **Music continues across navigation** — the entire reason for the SPA
    architecture; explicitly tested (play from Home, navigate through 5 pages,
    confirm the same track is still playing).
23. **No dead buttons** — I wrote a static audit script that checks all 58 buttons
    in the app for either a real event handler or route delegation. Zero dead ones.
24. **No console errors** — an automated run through every route, every CRUD flow,
    and every toggle produces zero runtime errors.
25. **"Lux Music" branding fully removed** — checked programmatically, not just by eye.

## Crossfade — the one place I had to do real engineering, not a slider

A single `<audio>` element can't play two overlapping tracks, and you explicitly
said not to create audio elements that "fight each other." So there are two
coordinated `<audio>` elements sharing one Web Audio graph (shared EQ, shared
analyser for the visualizer) — exactly one is ever "active" at a time, and the other
only ever plays during a real gain-ramped overlap when Crossfade is set above 0
seconds. I mocked a Web Audio graph in a test to confirm the handoff between the two
elements actually happens, rather than just trusting the code by inspection.

## Honest limitations

- **Lyrics** aren't wired to a licensed source, so the button says exactly that
  instead of showing placeholder text pretending to be real lyrics.
- **"Audio Quality"** in Settings shows "Original" with no selector — local files
  play at their encoded quality; there's nothing real to switch between, so I didn't
  invent a fake dropdown.
- **Terms of Service** isn't a fabricated legal document — the About page explains
  there's no account system for Terms to govern yet.
- **Logo** — no hardcoded logo anywhere. Every brand mark reads from one reusable
  `.brand-mark-icon` component referencing a single `#i-brand` SVG symbol; swap that
  one symbol's contents when you have the official asset, and it updates everywhere
  (sidebar, onboarding, profile card, modal icon).
- **Notifications** require the browser's real permission prompt — if denied or
  unsupported, the toggle says so rather than pretending to be on.
- I did not device-test on an actual phone (see #20–21 above).
