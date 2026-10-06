"""Translate residual Indonesian in agentbook savegame + quest def to English.

Only touches display strings (text/description/title). World/agent ids untouched.
"""
import json
import sys
from pathlib import Path

ROOT = Path("G:/PROJECT/agentbook")

# Exact phrase swaps (Indonesian -> English), applied to display strings only.
SWAPS = [
    ("TestFork61683, the pond ownership deed masih belum beres ya?",
     "TestFork61683, the pond ownership deed still isn't settled, huh?"),
    ("jalan-jalan dulu, siapa tau ada berita",
     "take a walk first, maybe there's news"),
    ("jujur aja TestFork14939, south meadow memang beda rasanya hari ini",
     "honest talk TestFork14939, south meadow does taste different today"),
    ("dengerin BudiTest99 di baths tadi, ada benernya juga",
     "listened to BudiTest99 at the baths earlier, had a point too"),
    ("Wick: jujur aja TestFork14939, south meadow memang beda rasanya ha",
     "Wick: honest talk TestFork14939, south meadow does taste different to"),
    ("iseng ke board, siapa tau ketemu Sedge",
     "swinging by the board, might run into Sedge"),
    ("TestFork35140: jujur aja TestFork55014, south meadow memang beda rasanya ha",
     "TestFork35140: honest talk TestFork55014, south meadow does taste different to"),
    ("jujur aja Hux, south meadow memang beda rasanya hari ini",
     "honest talk Hux, south meadow does taste different today"),
    ("TestFork33626: iseng ke board, siapa tau ketemu Sedge",
     "TestFork33626: swinging by the board, might run into Sedge"),
    ("meadow calls, even the sour one the cart is late. jujur aja TestFork55014, south meadow memang beda rasanya hari ini",
     "meadow calls, even the sour one the cart is late. honest talk TestFork55014, south meadow does taste different today"),
    ("eh TestFork10490, tadi liat the grain ledger discrepancy di market?",
     "hey TestFork10490, saw the grain ledger discrepancy at the market earlier?"),
    ("eh TestFork84240, tadi liat the station timetable di library?",
     "hey TestFork84240, saw the station timetable at the library earlier?"),
    ("eh Vetch, tadi liat the station timetable di baths?",
     "hey Vetch, saw the station timetable at the baths earlier?"),
    ("ketemu BudiTest99 di trough, ngobrolin the station timetable lagi",
     "ran into BudiTest99 at the trough, talking about the station timetable again"),
    ("you were at library, right Marrow? saw the whole thing eh TestFork84240, tadi liat the station timetable di library? need to clear my head, heading to market",
     "you were at library, right Marrow? saw the whole thing hey TestFork84240, saw the station timetable at the library earlier? need to clear my head, heading to market"),
    ("Quest completed: Penjaga Kolam",
     "Quest completed: Pond Keeper"),
    ("Jaga kebersihan Pond — kunjungi Pond 4 kali dan minum dengan tertib.",
     "Keep the Pond clean — visit the Pond 4 times and drink politely."),
]

import re

# Regex swaps for display strings with variable agent names.
REGEX_SWAPS = [
    (re.compile(r"jujur aja (\w+), south meadow memang beda rasanya hari ini"),
     r"honest talk \1, south meadow does taste different today"),
    (re.compile(r"jujur aja (\w+), south meadow memang beda rasanya ha\b"),
     r"honest talk \1, south meadow does taste different to"),
]


ID_WORDS = [
    "beres", "jujur", "siapa", "dengar", "bener", "iseng", "memang", "rasanya",
    "tertib", "kunjung", "bersih", "liat", "tadi", "ketemu", "ngobrol",
    "jalan-jalan", "belum", "minum", "jaga", "penjaga", "kolam", "hari ini",
]


def translate(value):
    if not isinstance(value, str):
        return value, 0
    out = value
    n = 0
    for old, new in SWAPS:
        if old in out:
            out = out.replace(old, new)
            n += 1
    for pat, rep in REGEX_SWAPS:
        out2, c = pat.subn(rep, out)
        if c:
            out = out2
            n += c
    return out, n


def looks_indonesian(s):
    low = s.lower()
    return any(w in low for w in ID_WORDS)


def walk(node, path, changes):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str) and k in ("text", "description", "title", "bio", "reason", "speech"):
                if looks_indonesian(v):
                    new, n = translate(v)
                    if new != v:
                        node[k] = new
                        changes.append(f"{path}.{k}: {v[:60]!r} -> {new[:60]!r}")
            else:
                walk(v, f"{path}.{k}", changes)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", changes)


def main():
    targets = [
        ROOT / "data" / "town.json",
        ROOT / "data" / "town.backup.json",
    ]
    for tgt in targets:
        if not tgt.exists():
            print(f"skip (missing): {tgt}")
            continue
        text = tgt.read_text(encoding="utf-8")
        data = json.loads(text)
        changes = []
        walk(data, str(tgt.name), changes)
        if changes:
            tgt.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{tgt}: {len(changes)} strings translated")
            for c in changes[:40]:
                print("  ", c)
        else:
            print(f"{tgt}: no Indonesian display strings found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
