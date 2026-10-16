"""Line illustrations for deck cards, in the deck's palette: cream strokes, one green (or orange) accent.
Each entry is the inner markup of a 200x140 viewBox. Use one in deck.md by ending a card bullet with {name}."""

C = 'stroke="#FEFDF5" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"'
G = 'stroke="#00E3AA" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"'
O = 'stroke="#FF7442" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"'
DIM = 'fill="#FEFDF5" fill-opacity=".35"'


def person(x, y, s=C):
    return f'<circle cx="{x}" cy="{y-14}" r="8" {s}/><path d="M{x-14} {y+16} a14 14 0 0 1 28 0" {s}/>'


ICONS = {
    "clock": f'<circle cx="62" cy="70" r="42" {C}/><path d="M62 70 V42" {C}/><path d="M62 70 L84 82" {G}/>'
             f'<circle cx="128" cy="70" r="6" fill="#FEFDF5" fill-opacity=".6"/><circle cx="150" cy="70" r="6" fill="#FEFDF5" fill-opacity=".38"/>'
             f'<circle cx="172" cy="70" r="6" fill="#FEFDF5" fill-opacity=".18"/>',
    "seats": f'<path d="M78 30 h22 a8 8 0 0 1 8 8 v44 h22 a8 8 0 0 1 8 8 v8 a8 8 0 0 1 -8 8 h-52 a8 8 0 0 1 -8 -8 v-60 a8 8 0 0 1 8 -8 z" {C}/>'
             f'<path d="M22 22 L66 56" {C}/><path d="M56 56 h10 v-10" {C}/><path d="M178 22 L134 56" {O}/><path d="M144 56 h-10 v-10" {O}/>',
    "seat": f'<path d="M78 30 h22 a8 8 0 0 1 8 8 v44 h22 a8 8 0 0 1 8 8 v8 a8 8 0 0 1 -8 8 h-52 a8 8 0 0 1 -8 -8 v-60 a8 8 0 0 1 8 -8 z" {C}/><path d="M80 118 h48" {G}/>',
    "queue": person(40, 80) + person(75, 80) + person(110, 80) + person(145, 80) + person(178, 80, G),
    "actor": f'<rect x="118" y="34" width="66" height="72" rx="12" {G}/><path d="M138 70 h26" {G}/>'
             f'<circle cx="22" cy="70" r="6" {DIM}/><circle cx="46" cy="70" r="6" {DIM}/><circle cx="70" cy="70" r="6" fill="#FEFDF5" fill-opacity=".7"/>'
             f'<path d="M86 70 h22" {C}/><path d="M100 62 l8 8 -8 8" {C}/>',
    "code": f'<polyline points="62,38 30,70 62,102" {C}/><polyline points="138,38 170,70 138,102" {C}/><path d="M112 32 L88 108" {G}/>',
    "gauge": f'<path d="M36 104 A64 64 0 0 1 164 104" {C}/><path d="M100 104 L140 62" {G}/><circle cx="100" cy="104" r="6" fill="#00E3AA"/>'
             f'<path d="M50 70 l8 6 M100 40 v10 M150 70 l-8 6" {C}/>',
    "phone": f'<rect x="70" y="18" width="52" height="104" rx="11" {C}/><path d="M88 108 h16" {C}/>'
             f'<path d="M136 52 a24 24 0 0 1 0 36" {G}/><path d="M150 40 a40 40 0 0 1 0 60" {G}/>',
    "id": f'<rect x="24" y="32" width="120" height="80" rx="11" {C}/>' + person(58, 76) +
          f'<path d="M88 58 h40 M88 78 h30" {C}/><circle cx="154" cy="104" r="20" fill="#000" {G}/><path d="M144 104 l7 7 13 -14" {G}/>',
    "bell": f'<path d="M68 96 h64 l-10 -13 v-24 a22 22 0 0 0 -44 0 v24 z" {C}/><path d="M92 104 a8 8 0 0 0 16 0" {C}/>'
            f'<path d="M48 50 a40 40 0 0 0 0 40 M152 50 a40 40 0 0 1 0 40" {G}/>',
    "trace": f'<path d="M20 70 H180" {C}/><circle cx="20" cy="70" r="7" fill="#000" {C}/><circle cx="60" cy="70" r="7" fill="#000" {C}/>'
             f'<circle cx="100" cy="70" r="7" fill="#000" {C}/><circle cx="140" cy="70" r="12" fill="#000" {G}/><circle cx="140" cy="70" r="4" fill="#00E3AA"/>'
             f'<circle cx="180" cy="70" r="7" fill="#000" {C}/>',
    "stack": f'<path d="M100 26 L162 52 L100 78 L38 52 Z" {G}/><path d="M38 74 L100 100 L162 74" {C}/><path d="M38 96 L100 122 L162 96" {C}/>',
    "hops": f'<path d="M24 50 L60 50 L96 50 L132 50 L176 50" stroke="#FEFDF5" stroke-opacity=".4" stroke-width="3" stroke-dasharray="5 7" fill="none"/>'
            + "".join(f'<circle cx="{x}" cy="50" r="7" fill="#000" stroke="#FEFDF5" stroke-opacity=".5" stroke-width="3"/>' for x in (24, 62, 100, 138, 176))
            + f'<path d="M24 98 H176" {G}/><circle cx="24" cy="98" r="8" fill="#000" {G}/><circle cx="176" cy="98" r="8" fill="#00E3AA"/>',
    "search": f'<circle cx="84" cy="64" r="36" {C}/><path d="M110 90 L148 124" stroke="#FEFDF5" stroke-width="6" stroke-linecap="round"/>'
              f'<path d="M66 56 h36 M66 72 h24" {G}/>',
    "doc": f'<path d="M62 18 h56 l22 22 v84 h-78 z" {C}/><path d="M118 18 v22 h22" {C}/><path d="M76 62 h48 M76 80 h36" {C}/>'
           f'<circle cx="140" cy="112" r="18" fill="#000" {G}/><path d="M131 112 l6 6 12 -13" {G}/>',
    "route": f'<path d="M34 108 Q96 0 166 48" stroke="#FEFDF5" stroke-width="3" stroke-dasharray="6 8" fill="none"/>'
             f'<circle cx="34" cy="108" r="8" fill="#000" {C}/><circle cx="166" cy="48" r="9" fill="#00E3AA"/>'
             f'<path d="M44 128 v-8 M64 128 v-16 M84 128 v-24" {G}/>',
    "callback": f'<rect x="40" y="22" width="50" height="100" rx="11" {C}/><path d="M56 108 h18" {C}/>'
                f'<path d="M110 92 a40 40 0 1 0 0 -44" {G}/><path d="M102 40 l8 8 -10 6" {G}/>',
    "headset": f'<path d="M54 86 v-16 a46 46 0 0 1 92 0 v16" {C}/><rect x="44" y="76" width="22" height="34" rx="8" {G}/>'
               f'<rect x="134" y="76" width="22" height="34" rx="8" {G}/><path d="M145 110 q0 18 -30 18 h-8" {C}/>',
    "power": f'<path d="M70 46 a42 42 0 1 0 60 0" {C}/><path d="M100 28 v44" {O}/>',
    "toggle": f'<rect x="40" y="46" width="120" height="52" rx="26" {C}/><circle cx="134" cy="72" r="18" fill="#FF7442"/>'
              f'<path d="M62 72 h30" stroke="#FEFDF5" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>',
    "shield": f'<path d="M100 20 L150 38 V72 C150 102 128 118 100 126 C72 118 50 102 50 72 V38 Z" {C}/><path d="M80 72 l14 14 26 -28" {G}/>',
    "db": f'<ellipse cx="100" cy="34" rx="50" ry="14" {C}/><path d="M50 34 v72 a50 14 0 0 0 100 0 v-72" {C}/>'
          f'<path d="M50 70 a50 14 0 0 0 100 0" {G}/>',
    "sliders": f'<path d="M40 44 H160 M40 72 H160 M40 100 H160" {C}/><circle cx="76" cy="44" r="10" fill="#000" {C}/>'
               f'<circle cx="128" cy="72" r="10" fill="#000" {G}/><circle cx="96" cy="100" r="10" fill="#000" {C}/>',
    "bars": f'<path d="M40 120 H164" {C}/><rect x="52" y="84" width="22" height="36" rx="4" {C}/><rect x="90" y="58" width="22" height="62" rx="4" {C}/>'
            f'<rect x="128" y="28" width="22" height="92" rx="4" {G}/>',
}


def icon(name, cls="ill", label=""):
    """Telnyx-style frame: a soft green glow and three rotated rounded squares behind the line drawing."""
    body = ICONS[name]
    frames = "".join(
        f'<rect x="{100 - w / 2}" y="{75 - w / 2}" width="{w}" height="{w}" rx="14" transform="rotate({a} 100 75)" '
        f'fill="none" stroke="#FEFDF5" stroke-opacity="{o}" stroke-width="1.4"/>'
        for w, a, o in ((132, -8, .10), (116, 6, .16), (100, 18, .22)))
    return (f'<svg class="{cls}" viewBox="-20 -20 240 190" aria-hidden="true">'
            f'<defs><radialGradient id="glow-{name}" cx="50%" cy="50%" r="50%">'
            f'<stop offset="0" stop-color="#00E3AA" stop-opacity=".30"/><stop offset="1" stop-color="#00E3AA" stop-opacity="0"/></radialGradient></defs>'
            f'<ellipse cx="100" cy="75" rx="110" ry="88" fill="url(#glow-{name})"/>{frames}'
            f'<g transform="translate(100 75) scale(.72) translate(-100 -72)">{body}</g>{pill(label)}</svg>')


def pill(label):
    """A white label pill on the frame's lower right, like the tags in Telnyx's own figures."""
    if not label:
        return ""
    w = len(label) * 8.4 + 30
    x = min(200 - w + 6, 168 - w / 2)
    return (f'<rect x="{x:.0f}" y="138" width="{w:.0f}" height="30" rx="15" fill="#FEFDF5"/>'
            f'<text x="{x + w / 2:.0f}" y="158" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" '
            f'font-weight="600" fill="#000">{label}</text>')
