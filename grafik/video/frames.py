# python3 frames.py still t1 t2 ...   |   python3 frames.py scene name t0 t1
import sys, subprocess, os
from playwright.sync_api import sync_playwright
FPS = 30
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1920, "height": 1080}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("file:///home/claude/crossover/video/video.html"); pg.evaluate("window.ready"); pg.wait_for_timeout(400)
    if sys.argv[1] == "still":
        for t in sys.argv[2:]: pg.evaluate(f"render({t})"); pg.screenshot(path=f"still_{t}.png")
    else:
        name, t0, t1 = sys.argv[2], float(sys.argv[3]), float(sys.argv[4]); n = round((t1 - t0) * FPS); tmp = f"{name}.tmp.mp4"
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS), tmp], stdin=subprocess.PIPE)
        for i in range(n): pg.evaluate(f"render({t0 + i / FPS})"); ff.stdin.write(pg.screenshot(type="jpeg", quality=92))
        ff.stdin.close()
        if ff.wait() == 0: os.replace(tmp, f"{name}.mp4")
        print(name, n, "frames")
    print("errors:", errs); b.close()
