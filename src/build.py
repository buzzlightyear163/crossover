# python3 src/build.py  -> bakes src/index.src.html + site.css + termkit.js + flow.js + fingerprints.json into index.html
import pathlib, json
root = pathlib.Path(__file__).resolve().parent.parent; src = root / "src"
s = (src / "index.src.html").read_text()
s = s.replace('<link rel="stylesheet" href="site.css">', "<style>\n" + (src / "site.css").read_text().replace("url(fonts/", "url(/fonts/") + "</style>")
s = s.replace('<script src="termkit.js"></script>', "<script>\n" + (src / "termkit.js").read_text() + "</script>")
s = s.replace('<script src="flow.js"></script>', "<script>\n" + (src / "flow.js").read_text() + "</script>")
fp = json.loads((root / "fingerprints.json").read_text())
s = s.replace("/*@FP@*/null", json.dumps(fp, separators=(",", ":")))
snap = root / "snapshot.json"
s = s.replace("/*@SNAP@*/null", snap.read_text().strip() if snap.exists() else "null")
(root / "index.html").write_text(s); print("index.html", len(s), "bytes")
