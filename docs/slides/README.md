# Demo-round slides

The deck presented at the Telnyx demo round on 2026-10-16: a technical story with the live demo in
the middle. Slides 1–4 set up the problem and the architecture, 5 is the demo, 6–12 go under the
hood (load proof, trade-offs, the worst bug, Telnyx lessons, health, status, next), 13 closes, and
15–22 are appendix Q&A.

- `deck.html`: open it in a browser. `f` for full screen, `o` to jump to any slide.
- [`deck.md`](deck.md): the slide source.
- [`build.py`](build.py): rebuilds `deck.html` from `deck.md` (`python3 build.py`); [`icons.py`](icons.py) draws the card illustrations.
- `assets/`: the architecture diagram, Inter and Space Grotesk fonts (OFL) and the Telnyx wordmark, inlined by `build.py`.
