#!/usr/bin/env python3
"""Build deck.html (one self-contained file, Telnyx-style) from deck.md.

Usage: python3 build.py   (run from anywhere; reads deck.md and assets/ beside this file)
Keys in the deck: → / space next, ← back, f full screen, o overview (jump to any slide), Home/End. Prints one slide per page.
"""
import base64
import html
import pathlib
import re

from icons import icon

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE / "assets"


def b64(name):
    return base64.b64encode((ASSETS / name).read_bytes()).decode()


def inline(text):
    t = html.escape(text, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"(\d) (ms|s|seconds|minutes|minute|calls|seats)\b", "\\1&nbsp;\\2", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<![*\w])\*([^*]+)\*(?!\*)", r"<em>\1</em>", t)
    return t


def split_source(text):
    m = re.search(r"\*Source:\s*(.+?)\*\s*$", text)
    if not m:
        return text.strip(), ""
    return text[: m.start()].strip(), m.group(1).strip()


def parse(slide):
    shape = re.search(r"<!--\s*shape:\s*([\w-]+)\s*-->", slide).group(1)
    sec = re.search(r"<!--\s*section:\s*(.+?)\s*-->", slide)
    body = re.sub(r"<!--.*?-->", "", slide, flags=re.S)
    lines = [l.rstrip() for l in body.strip().splitlines()]
    d = {"shape": shape, "eyebrow": "", "head": "", "sub": "", "items": [], "rows": [],
         "options": [], "source": "", "section": sec.group(1) if sec else "The story", "image": ""}
    i = 0
    while i < len(lines):
        l = lines[i]
        s = l.strip()
        if not s:
            i += 1
            continue
        if s.startswith("### "):
            title, buf = s[4:], []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("### "):
                if lines[i].strip():
                    buf.append(lines[i].strip())
                i += 1
            text, src = split_source(" ".join(buf))
            d["options"].append((title, text, src))
            continue
        if s.startswith("!["):
            d["image"] = re.search(r"\((.+?)\)", s).group(1)
        elif re.match(r"^#{1,2} ", s):
            d["head"] = re.sub(r"^#{1,2} ", "", s)
        elif s.startswith("|"):
            if not re.match(r"^\|[\s:|-]+\|$", s):
                d["rows"].append([c.strip() for c in s.strip("|").split("|")])
        elif re.match(r"^(-|\d+\.) ", s):
            d["items"].append(re.sub(r"^(-|\d+\.) ", "", s))
        elif s.startswith("*Source:") or (s.startswith("*") and s.endswith("*") and (shape == "title" or not d["head"])):
            if s.startswith("*Source:"):
                d["source"] = s.strip("*")[len("Source:"):].strip()
            else:
                d["source"] = s.strip("*")
        elif not d["head"]:
            d["eyebrow"] = s
        elif not d["sub"]:
            d["sub"] = s
        i += 1
    return d


LABELS = {"evidence": "ev", "assumption": "as", "proposal": "pr"}


ICON = re.compile(r"\s*\{(\w+)(?:\|([^}]*))?\}\s*$")


def take_icon(text):
    """Split a trailing {name} illustration marker off a bullet."""
    m = ICON.search(text)
    return (text[: m.start()], (m.group(1), m.group(2) or "")) if m else (text, "")


POINT = re.compile(r"^(Open:\s*|Works:\s*)?\*\*(.+?)\*\*\s*—\s*(.*)$")


def render_points(d):
    """Bullets written as **Lead** — detail become numbered cards; an Open: prefix marks a rough edge."""
    cards = []
    for n, it in enumerate(d["items"], 1):
        it, ill = take_icon(it)
        m = POINT.match(it)
        tag = (m.group(1) or "").strip(": ")
        op = tag == "Open"
        kick = f'<span class="pill">{tag}</span>' if tag else ""
        art = icon(ill[0], label=ill[1]) if ill else ""
        cards.append(f'<div class="pt{" op" if op else ""}{" works" if tag == "Works" else ""}{" has-ill" if ill else ""}"><div class="k">{kick}</div><div class="ghost">{n:02d}</div>{art}'
                     f'<h3>{inline(m.group(2))}</h3><p>{inline(m.group(3))}</p></div>')
    return f'<div class="points g{len(cards)}">{"".join(cards)}</div>'


def render_timeline(d):
    """Numbered steps left to right; the step marked with a leading ! is the turning point."""
    steps = []
    for n, it in enumerate(d["items"], 1):
        key = it.startswith("!")
        m = re.match(r"\*\*(.+?)\*\*\s*—\s*(.*)", it.lstrip("! "))
        steps.append(f'<div class="ts{" key" if key else ""}"><div class="n">{n}</div>'
                     f'<h3>{inline(m.group(1))}</h3><p>{inline(m.group(2))}</p></div>')
    return f'<div class="tl" style="grid-template-columns:repeat({len(steps)},1fr)">{"".join(steps)}</div>'


def render_findings(d):
    if d["items"] and all(POINT.match(take_icon(it)[0]) for it in d["items"]):
        return render_points(d)
    out = []
    for it in d["items"]:
        m = re.match(r"\*\*(Evidence|Assumption|Proposal)\*\*\s*·\s*(.*)", it)
        label, rest = (m.group(1), m.group(2)) if m else ("", it)
        text, src = split_source(rest)
        cls = LABELS[label.lower()] if label else ""
        if text.startswith("Open:"):
            label, cls, text = "Open", "op", text[5:].strip()
            text = text[0].upper() + text[1:]
        tag = f'<span class="tag {cls}">{label}</span>' if label else "<span></span>"
        src_html = f'<div class="src">{inline(src)}</div>' if src else ""
        out.append((bool(label), f'<div class="row">{tag}<div><div class="txt">{inline(text)}</div>{src_html}</div></div>'))
    # Plain bullets drop the tag column; a slide that mixes in an Open tag keeps it so text aligns.
    if not any(t for t, _ in out):
        return '<div class="rows plain">' + "".join(h.replace("<span></span>", "", 1) for _, h in out) + "</div>"
    return f'<div class="rows">{"".join(h for _, h in out)}</div>'


def render_architecture(d):
    if d["image"]:
        data = base64.b64encode((HERE / d["image"]).read_bytes()).decode()
        steps = []
        for n, it in enumerate(d["items"], 1):
            m = re.match(r"\*\*(.+?)\*\*\s*—\s*(.*)", it)
            steps.append(f'<div class="step-chip"><span class="num">{n}</span><b>{inline(m.group(1))}</b> {inline(m.group(2))}</div>')
        legend = ('<div class="legend"><span><i class="sq"></i>Request</span><span><i class="ci"></i>Response</span>'
                  '<span><i class="di"></i>Change</span><span class="mut">accent = the seat path</span></div>')
        return (f'<div class="figure"><img src="data:image/svg+xml;base64,{data}" alt="Architecture">{legend}</div>'
                f'<div class="steps">{"".join(steps)}</div>')
    cards = []
    for n, it in enumerate(d["items"], 1):
        it, ill = take_icon(it)
        m = re.match(r"\*\*(.+?)\*\*\s*—\s*(.*)", it)
        name, detail = (m.group(1), m.group(2)) if m else (it, "")
        art = icon(ill[0], label=ill[1]) if ill else ""
        cards.append(f'<div class="card{" has-ill" if ill else ""}"><div class="num"></div><div class="ghost">{n:02d}</div>{art}<h3>{inline(name)}</h3>'
                     f'<p>{inline(detail)}</p></div>')
    return f'<div class="grid g{len(cards)}">{"".join(cards)}</div>'


def render_results(d):
    rows = d["rows"]
    head, data = rows[0], rows[1:]
    if len(head) == 2:  # value | meaning → stat cards
        cards = "".join(f'<div class="card stat"><div class="big">{inline(v)}</div><p>{inline(t)}</p></div>'
                        for v, t in data)
        return f'<div class="grid g{len(data)}">{cards}</div>'
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    trs = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in data)
    return f'<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'


def render_comparison(d):
    cards = []
    for k, (title, text, src) in enumerate(d["options"]):
        cls = "card opt hero" if k == len(d["options"]) - 1 else "card opt"
        src_html = f'<div class="src">{inline(src)}</div>' if src else ""
        cards.append(f'<div class="{cls}"><h3>{inline(title)}</h3><p>{inline(text)}</p>{src_html}</div>')
    return f'<div class="grid g{len(cards)}">{"".join(cards)}</div>'


def render_next(d):
    out = []
    for it in d["items"]:
        m = re.match(r"(.*?)\s*Owner:\s*(.*?)\.\s*Date:\s*(.*)$", it)
        act, owner, date = (m.group(1), m.group(2), m.group(3)) if m else (it, "", "")
        out.append(f'<div class="row step"><div class="txt">{inline(act)}</div>'
                   f'<div class="meta"><span>Owner</span>{inline(owner)}</div>'
                   f'<div class="meta"><span>When</span>{inline(date)}</div></div>')
    return f'<div class="rows">{"".join(out)}</div>'


TITLE_ART = """
<div class="art" aria-hidden="true">
  <svg class="loop" viewBox="0 0 640 520"><ellipse cx="320" cy="270" rx="300" ry="215" fill="none"
   stroke="#FEFDF5" stroke-opacity=".55" stroke-width="2" stroke-dasharray="6 9"/></svg>
  <div class="bubble b1"><span class="dot"></span>Hi Jun. Your flight to Hong Kong is cancelled.</div>
  <div class="bubble b2">Rebook me on tomorrow's first flight, please.</div>
  <div class="bubble b3"><span class="dot"></span>NB860 tomorrow, 07:10. Seat held. Free under the waiver.</div>
</div>"""


def render(d, n, total):
    shape = d["shape"]
    eb = re.sub(r"^\d+\s*/\s*", "", d["eyebrow"])
    eyebrow = f'<div class="eyebrow">{inline(eb)}</div>' if eb else ""
    sub = f'<p class="lead">{inline(d["sub"])}</p>' if d["sub"] else ""
    src = f'<div class="foot-src">Source: {inline(d["source"])}</div>' if d["source"] else ""
    if shape == "title":
        return (f'<section class="slide title" data-title="{html.escape(d["head"])}" data-section="Start">{TITLE_ART}<div class="tbody">{eyebrow}'
                f'<h1>{inline(d["head"])}</h1>{sub}<div class="byline">{inline(d["source"])}</div></div>'
                f'<div class="brand">BUILT ON <img src="data:image/svg+xml;base64,{LOGO}" alt="Telnyx"></div></section>')
    if shape == "divider":
        return (f'<section class="slide divider" data-title="{html.escape(d["head"])}" data-section="{html.escape(d["section"])}">'
                f'<div class="dbody">{eyebrow}<h1>{inline(d["head"])}</h1>{sub}</div>'
                f'<div class="foot"><span>{html.escape(d["section"])}</span><span>{n:02d} / {total:02d}</span></div></section>')
    body = {"findings": render_findings, "architecture": render_architecture, "results": render_results,
            "comparison": render_comparison, "next-steps": render_next, "timeline": render_timeline}[shape](d)
    fig = " has-figure" if d["image"] else ""
    return (f'<section class="slide {shape}{fig}" data-title="{html.escape(d["head"])}" data-section="{html.escape(d["section"])}">{eyebrow}<h2>{inline(d["head"])}</h2>{sub}'
            f'<div class="body">{body}</div>{src}'
            f'<div class="foot"><span>Nimbus Air Disruption Desk · {html.escape(d["section"])}</span><span>{n:02d} / {total:02d}</span></div></section>')


CSS = """
@font-face{font-family:Display;src:url(data:font/woff2;base64,@@sg@@) format('woff2');font-weight:700}
@font-face{font-family:Inter;src:url(data:font/woff2;base64,@@ir@@) format('woff2');font-weight:400}
@font-face{font-family:Inter;src:url(data:font/woff2;base64,@@im@@) format('woff2');font-weight:500}
@font-face{font-family:Inter;src:url(data:font/woff2;base64,@@is@@) format('woff2');font-weight:600}
:root{--black:#000;--cream:#FEFDF5;--green:#00E3AA;--citron:#D3FFA6;--lilac:#C9A8FF;--g90:#222227;
--g80:#3D3D46;--g50:#909093;--display:Display,"Space Grotesk",-apple-system,sans-serif;
--body:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;height:100%;overflow:hidden}
#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0}
.slide{position:absolute;inset:0;padding:110px 150px 120px;background:var(--black);color:var(--cream);
font-family:var(--body);font-size:30px;line-height:1.4;letter-spacing:-.01em;display:flex;flex-direction:column;
visibility:hidden;opacity:0;transition:opacity .35s ease}
.slide.active{visibility:visible;opacity:1}
.eyebrow{font-family:var(--display);font-size:24px;letter-spacing:.06em;color:var(--cream);text-transform:uppercase;margin-bottom:26px}
h1,h2,h3{font-family:var(--display);font-weight:700;letter-spacing:-.03em}
h1{font-size:104px;line-height:1.02;max-width:980px}
h2{font-size:64px;line-height:1.06;max-width:1450px;text-wrap:balance}
h3{font-size:34px;line-height:1.15}
.lead{font-size:32px;color:#cfcdc4;margin-top:24px;max-width:1450px}
.body{flex:1;display:flex;flex-direction:column;justify-content:flex-start;padding:56px 0 10px}
code{font-family:var(--mono);font-size:.86em;background:var(--g90);border:1px solid var(--g80);border-radius:8px;padding:1px 9px}
strong{font-weight:600;color:#fff}
.rows{border-top:1px solid var(--g80)}
.rows.plain .row{grid-template-columns:1fr;padding:26px 0}.rows.plain .txt{font-size:38px;line-height:1.3}.rows .txt{font-size:36px;line-height:1.3}
.row{display:grid;grid-template-columns:210px 1fr;gap:36px;padding:22px 0;border-bottom:1px solid var(--g80);align-items:start}
.txt{font-size:30px;line-height:1.36;text-wrap:pretty}
.src,.foot-src{font-size:24px;color:#a3a3a6;margin-top:8px}
.foot-src{margin-top:0;margin-bottom:10px}
.tag{justify-self:start;font-family:var(--display);font-size:22px;letter-spacing:.07em;text-transform:uppercase;
border-radius:48px;padding:9px 20px;margin-top:2px;border:1.5px solid}
.tag.ev{color:var(--green);border-color:var(--green)}
.tag.as{color:var(--citron);border-color:var(--citron)}
.tag.pr{color:var(--lilac);border-color:var(--lilac)}
.tag.op{color:#FF7442;border-color:#FF7442}
.grid{display:grid;gap:32px}
.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}
.card{border:1px solid var(--g80);border-radius:24px;padding:40px 38px;background:#000}
.card .num{font-family:var(--display);font-size:24px;color:var(--green);margin-bottom:56px}
.card h3{margin-bottom:18px;text-wrap:balance}
.card p{font-size:26px;color:#bdbbb3;line-height:1.38;text-wrap:pretty}
.stat .big{font-family:var(--display);font-size:80px;line-height:1;margin-bottom:26px;color:var(--cream)}
.stat .big strong{color:var(--green)}
table{width:100%;border-collapse:collapse;font-size:32px}
th{font-family:var(--display);font-size:20px;letter-spacing:.06em;text-transform:uppercase;color:var(--g50);text-align:left;
font-weight:700;padding:0 0 22px;border-bottom:1px solid var(--g80)}
td{padding:34px 0;border-bottom:1px solid var(--g80)}
td:not(:first-child),th:not(:first-child){text-align:right}
td strong{font-family:var(--display);font-size:56px;color:var(--green)}
tbody tr:last-child td strong{color:#FF7442}
.opt h3{font-size:40px;margin-bottom:22px}.opt p{font-size:28px}
.opt.hero{background:var(--cream);border-color:var(--cream)}
.opt.hero h3,.opt.hero p,.opt.hero strong{color:#000}.opt.hero .src{color:#55544f}
.opt.hero{position:relative}
.opt.hero::after{content:"";position:absolute;inset:auto 38px 30px auto;width:80px;height:10px;border-radius:10px;
background:linear-gradient(90deg,#66eecc,#c9a8ff)}
.step{grid-template-columns:1fr 400px 200px}
.meta{font-size:25px;color:#cfcdc4;text-wrap:pretty}.meta span{display:block;font-family:var(--display);font-size:20px;letter-spacing:.07em;
text-transform:uppercase;color:var(--g50);margin-bottom:6px}
.foot{position:absolute;left:150px;right:150px;bottom:44px;display:flex;justify-content:space-between;
font-family:var(--display);font-size:22px;letter-spacing:.06em;text-transform:uppercase;color:var(--g50)}
.title{justify-content:center}
.title .tbody{position:relative;z-index:2}
.title .lead{max-width:900px;font-size:34px}
.byline{margin-top:56px;font-size:22px;color:var(--g50)}
.brand{position:absolute;left:150px;top:96px;display:flex;align-items:center;gap:18px;font-family:var(--display);
font-size:18px;letter-spacing:.08em;color:var(--g50)}
.brand img{height:36px}
.art{position:absolute;right:150px;top:270px;width:600px;height:520px}
.art .loop{position:absolute;inset:0;width:100%;height:100%}
.bubble{position:absolute;font-size:23px;line-height:1.3;padding:20px 26px;border-radius:22px;max-width:390px;
background:#0b0b0b;border:1px solid var(--g80);box-shadow:0 0 0 1px rgba(0,0,0,.4)}
.bubble .dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--green);margin-right:12px;vertical-align:2px}
.b1{left:30px;top:50px;border-left:6px solid #66eecc}
.b2{right:0;top:230px;background:var(--cream);color:#000;border-color:var(--cream)}
.b3{left:60px;top:400px;border-left:6px solid #c9a8ff}
.g5{grid-template-columns:repeat(5,1fr);gap:24px}
.g5 .card{padding:36px 30px;min-height:520px}.g5 .card.has-ill .ill{max-width:190px;margin:18px auto 22px}.g5 .card h3{font-size:32px}.g5 .card p{font-size:27px;line-height:1.4}.g5 .card .num{margin-bottom:36px}
.has-figure{padding-top:72px;padding-bottom:100px}.has-figure .eyebrow{margin-bottom:14px}.has-figure h2{font-size:46px;max-width:1620px;text-wrap:nowrap}.has-figure .body{padding-top:24px;justify-content:flex-start}
.figure{border:1px solid var(--g80);border-radius:16px;overflow:hidden;background:#000;position:relative}
.figure img{display:block;width:100%;height:auto;max-height:690px;object-fit:contain}
.legend{position:absolute;right:24px;bottom:16px;display:flex;gap:26px;font-family:var(--mono);font-size:20px;color:#cfcdc4}
.legend i{display:inline-block;width:12px;height:12px;margin-right:10px;vertical-align:0}
.legend .sq{background:#FEFDF5}.legend .ci{background:#00E3AA;border-radius:50%}.legend .di{background:#D3FFA6;transform:rotate(45deg) scale(.85)}
.legend .mut{color:var(--green)}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:18px}
.step-chip{font-size:23px;color:#cfcdc4;line-height:1.35}.step-chip b{color:var(--cream);font-weight:600}
.step-chip .num{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--green);color:#000;font:700 17px var(--body);margin-right:12px;vertical-align:2px}
.points{display:grid;gap:28px}.points.g4,.points.g2{grid-template-columns:1fr 1fr}.points.g3{grid-template-columns:repeat(3,1fr)}
.pt{position:relative;border:1px solid var(--g80);border-radius:24px;padding:38px 42px 40px;background:linear-gradient(180deg,#0d0d10 0%,#000 70%);overflow:hidden}
.pt::before{content:"";position:absolute;left:42px;top:0;width:72px;height:5px;background:var(--green);border-radius:0 0 5px 5px}
.pt .k{font-family:var(--display);font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:var(--green)}
.pt h3{font-size:40px;line-height:1.1;margin:18px 0 14px;text-wrap:balance}
.pt p{font-size:28px;color:#bdbbb3;line-height:1.4;text-wrap:pretty}
.points.g3 .pt{padding-top:40px;padding-bottom:34px}.points.g3 .pt h3{font-size:42px}
.pt.op::before{background:#FF7442}.pt.op .k{color:#FF7442}
.tl{display:grid;gap:36px;position:relative;margin-top:40px}
.ts{position:relative}.ts:not(:last-child)::after{content:"";position:absolute;left:64px;right:-28px;top:28px;border-top:2px dashed var(--g80)}
.ts .n{position:relative;z-index:1;width:56px;height:56px;border-radius:50%;border:2px solid var(--green);background:#000;color:var(--green);
display:flex;align-items:center;justify-content:center;font:700 24px var(--display)}
.ts h3{font-size:36px;margin:34px 0 14px;text-wrap:balance}.ts p{font-size:27px;color:#bdbbb3;line-height:1.4;text-wrap:pretty}
.ts.key .n{background:var(--green);color:#000}.ts.key h3{color:var(--green)}
.points{flex:1;grid-auto-rows:1fr;max-height:600px}.findings .body:has(.points){padding-top:48px}
.pt{display:flex;flex-direction:column}.pt h3{margin-top:auto;font-size:44px}.pt p{font-size:30px}
.points.g3{max-height:560px}.points.g3 .pt h3{font-size:46px}
.ts h3{font-size:40px}.ts p{font-size:29px}.tl{margin-top:48px}
.ill{display:block;width:100%;max-width:300px;height:auto;margin:auto 0 0}
.points.g3 .pt .ill{max-width:340px;margin:auto 0}.points.g3 .pt.has-ill h3{margin-top:0}
.points.g4 .pt .ill,.points.g2 .pt .ill{position:absolute;right:30px;top:26px;width:150px}.points.g4 .pt.has-ill h3{padding-right:150px}
.card.has-ill{display:flex;flex-direction:column}.card.has-ill .num{margin-bottom:0}.card.has-ill .ill{max-width:240px;margin:28px auto 30px;justify-self:center}
/* Row alignment: cards in a row share their row lines (subgrid), so every headline ends on the
   same line and every subtitle starts at the same height, whatever the headline's length. */
.points{row-gap:0}
.points .pt{display:grid;grid-row:span 4;grid-template-rows:subgrid;row-gap:0}
.pt>.k{grid-row:1}.pt>.ill{grid-row:2}.pt>h3{grid-row:3;align-self:end;margin:22px 0 14px}.pt>p{grid-row:4}
.points.g3{grid-template-rows:auto auto minmax(max-content,1fr) auto;max-height:none}
.points.g4,.points.g2{grid-template-rows:auto auto minmax(max-content,1fr) auto auto auto minmax(max-content,1fr) auto;max-height:none}
.points.g4 .pt:nth-child(-n+2),.points.g2 .pt:nth-child(-n+2){margin-bottom:28px}
.points.g4 .pt>.ill,.points.g2 .pt>.ill{grid-row:auto}
.points.g3 .pt>.ill{justify-self:center;width:240px;margin:12px 0 28px}
.grid.g4:has(.card),.grid.g5:has(.card),.grid.g3:has(.card){grid-template-rows:auto auto minmax(max-content,auto) 1fr;row-gap:0}
.grid .card{display:grid;grid-row:span 4;grid-template-rows:subgrid;row-gap:0}
.card>.num{grid-row:1}.card>.ill{grid-row:2}.card>h3{grid-row:3;align-self:end}.card>p{grid-row:4}
.grid .card:not(.has-ill)>h3{grid-row:2 / 4}
.divider{justify-content:center}.divider .dbody{max-width:1400px}.divider h1{font-size:120px}.divider .lead{font-size:38px;margin-top:32px}
.divider .eyebrow{color:var(--green)}
.foot{color:#a9a9a4}.byline{font-size:26px;color:rgba(254,253,245,.72)}.brand{color:#a9a9a4}
.points.g3{max-height:none}.body{padding-bottom:28px}
.pt.works .k{color:var(--green)}
/* Telnyx card treatment: grey panel, big faded number top-right, dark pill tags. */
.pt,.card{background:#1d1d21;border:1px solid #2a2a30;border-radius:32px;position:relative;overflow:hidden}
.pt::before{display:none}
.ghost{position:absolute;top:22px;right:34px;font-family:var(--display);font-weight:700;font-size:92px;line-height:1;
color:#34343b;letter-spacing:-.02em;pointer-events:none}
.points.g4 .ghost,.points.g2 .ghost{font-size:64px;top:18px;right:28px}
.g5 .ghost{font-size:64px;top:18px;right:24px}
.pt>.k{min-height:0}.pill{display:inline-block;background:#000;border-radius:40px;padding:10px 22px;font-family:var(--display);
font-size:22px;letter-spacing:.06em;text-transform:uppercase}
.pt.op .pill{color:#FF7442}.pt.works .pill{color:var(--green)}
.pt>.k:empty,.card>.num:empty{display:none}
.points.g4 .pt>.ill,.points.g2 .pt>.ill{display:none}.points.g4 .pt.has-ill h3{padding-right:0}
.points.g4 .pt h3,.points.g2 .pt h3{padding-right:120px}
.points.g3 .pt>.ill{width:300px;margin:8px 0 20px}
.card.has-ill .ill{max-width:250px;margin-top:64px}.grid.g4 .ghost{font-size:76px}
.g5 .card.has-ill .ill{max-width:200px;margin-top:46px}
#ov{position:fixed;inset:0;background:rgba(0,0,0,.94);display:none;overflow:auto;padding:48px 64px;z-index:9;font-family:var(--body);color:var(--cream)}
#ov.on{display:block}#ov h4{font-family:var(--display);font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:var(--g50);margin:22px 0 8px}
#ov a{display:block;color:var(--cream);text-decoration:none;font-size:17px;padding:6px 10px;border-radius:8px}
#ov a:hover,#ov a.cur{background:var(--g90)}#ov a span{color:var(--g50);font-family:var(--mono);margin-right:12px}
.findings h2{font-size:56px}.findings .lead{margin-top:16px}.findings .body{padding-top:40px}.findings .row{padding:18px 0}
.has-figure .foot-src{display:none}
.row:not(:has(.src)){align-items:center}.row:not(:has(.src)) .tag{margin-top:0}
#bar{position:fixed;left:0;bottom:0;height:3px;background:var(--green);transition:width .3s}
@media print{@page{size:1920px 1080px;margin:0}html,body{overflow:visible;height:auto}#stage{position:static;transform:none!important}
.slide{position:relative;visibility:visible;opacity:1;break-after:page;height:1080px;width:1920px}#bar,#ov{display:none!important}}
"""

JS = """
const st=document.getElementById('stage'),S=[...document.querySelectorAll('.slide')],bar=document.getElementById('bar');
let i=Math.max(0,Math.min(S.length-1,(parseInt(location.hash.slice(1))||1)-1));
function fit(){const k=Math.min(innerWidth/1920,innerHeight/1080);st.style.transform=`translate(${(innerWidth-1920*k)/2}px,${(innerHeight-1080*k)/2}px) scale(${k})`}
function go(n){i=Math.max(0,Math.min(S.length-1,n));S.forEach((s,j)=>s.classList.toggle('active',j===i));bar.style.width=((i+1)/S.length*100)+'%';history.replaceState(null,'','#'+(i+1))}
addEventListener('resize',fit);
addEventListener('keydown',e=>{if(document.getElementById('ov').classList.contains('on'))return;if(['ArrowRight','PageDown',' ','Enter'].includes(e.key))go(i+1);else if(['ArrowLeft','PageUp','Backspace'].includes(e.key))go(i-1);
else if(e.key==='Home')go(0);else if(e.key==='End')go(S.length-1);else if(e.key==='f')document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()});
const ov=document.getElementById('ov');let last='';
S.forEach((s,j)=>{const sec=s.dataset.section;if(sec!==last){const h=document.createElement('h4');h.textContent=sec;ov.appendChild(h);last=sec}
const a=document.createElement('a');a.href='#'+(j+1);a.innerHTML='<span>'+String(j+1).padStart(2,'0')+'</span>'+s.dataset.title;
a.onclick=e=>{e.preventDefault();e.stopPropagation();go(j);ov.classList.remove('on')};ov.appendChild(a)});
addEventListener('keydown',e=>{if(e.key==='o'||e.key==='Escape'&&ov.classList.contains('on')){ov.classList.toggle('on');[...ov.querySelectorAll('a')].forEach((a,j)=>a.classList.toggle('cur',j===i))}},true);
addEventListener('click',e=>{if(ov.classList.contains('on'))return;go(e.clientX>innerWidth/3?i+1:i-1)});
fit();go(i);
"""

LOGO = base64.b64encode((ASSETS / "telnyx-logo-text.svg").read_text().replace('fill="black"', 'fill="#FEFDF5"')
                        .replace('fill="#000000"', 'fill="#FEFDF5"').encode()).decode()


def main():
    src = (HERE / "deck.md").read_text()
    end = src.find("\n---\n", 4)
    front, body = src[4:end], src[end + 5:]
    title = re.search(r'^title:\s*"?(.*?)"?$', front, re.M).group(1)
    slides = [parse(s) for s in re.split(r"^---[ \t]*$", body, flags=re.M) if s.strip()]
    sections = "\n".join(render(d, n, len(slides)) for n, d in enumerate(slides, 1))
    css = CSS
    for k, f in {"sg": "SpaceGrotesk-700.woff2", "ir": "Inter_Regular.woff2",
                 "im": "Inter_Medium.woff2", "is": "Inter_SemiBold.woff2"}.items():
        css = css.replace("@@%s@@" % k, b64(f))
    out = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>'
           f'<meta name="viewport" content="width=device-width,initial-scale=1"><style>{css}</style></head>'
           f'<body><div id="stage">{sections}</div><div id="bar"></div><div id="ov"></div><script>{JS}</script></body></html>')
    (HERE / "deck.html").write_text(out)
    print(f"deck.html: {len(slides)} slides, {len(out)//1024} KB")


if __name__ == "__main__":
    main()
