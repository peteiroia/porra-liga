# Genera el icono de La Porra (estilo juego): python3 tools/icono.py
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np, math, sys
INK = (26, 16, 48)
def font(sz):
    for f in ["/usr/share/fonts/opentype/inter/Inter-BlackItalic.otf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
        try: return ImageFont.truetype(f, sz)
        except Exception: pass
def render(S=1024, scale=1.0, ribbon=True):
    W = S * 2
    y, x = np.mgrid[0:W, 0:W].astype(float); cx = cy = W / 2
    r = np.hypot(x - cx, y - cy) / (W * 0.72)
    base = np.stack([255 - 25 * r, 212 - 75 * r, 64 - 50 * r], -1)
    rays = np.sin(np.arctan2(y - cy, x - cx) * 12) > 0
    base = base * np.where(rays[..., None], 1.0, 0.9)
    img = Image.fromarray(np.clip(base, 0, 255).astype("uint8")).convert("RGBA")
    R = int(W * 0.36 * scale); C = (W // 2, int(W * (0.44 if ribbon else 0.5)))
    disc = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    def quad(q, fn):
        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0)); fn(ImageDraw.Draw(layer))
        m = Image.new("L", (W, W), 0)
        a0 = {0: 180, 1: 270, 2: 0, 3: 90}[q]
        ImageDraw.Draw(m).pieslice([C[0]-R, C[1]-R, C[0]+R, C[1]+R], a0, a0 + 90, fill=255)
        disc.paste(layer, (0, 0), m)
    def stripes(cols, n, angle):
        def fn(ld):
            w = W / n * 0.9; t = math.tan(math.radians(angle)) * W
            for i in range(-n, 2 * n):
                ld.polygon([(i*w, 0), ((i+1)*w, 0), ((i+1)*w + t, W), (i*w + t, W)], fill=cols[i % len(cols)])
        return fn
    def madrid(ld):
        ld.rectangle([0, 0, W, W], fill="#ffffff")
        ld.polygon([(C[0], C[1]-R*.55), (C[0]+R, C[1]-R*.95), (C[0]+R, C[1]-R*.75), (C[0], C[1]-R*.35)], fill="#febe10")
        ld.polygon([(C[0], C[1]-R*.35), (C[0]+R, C[1]-R*.75), (C[0]+R, C[1]-R*.6), (C[0], C[1]-R*.2)], fill="#3e2f8f")
    def celta(ld):
        ld.rectangle([0, 0, W, W], fill="#8ac6ee")
        ld.polygon([(C[0], C[1]+R*.2), (C[0]+R, C[1]+R*.6), (C[0]+R, C[1]+R*.75), (C[0], C[1]+R*.35)], fill="#ffffff")
        ld.polygon([(C[0], C[1]+R*.35), (C[0]+R, C[1]+R*.75), (C[0]+R, C[1]+R*.85), (C[0], C[1]+R*.45)], fill="#e30613")
    quad(0, stripes(["#a50044", "#004d98"], 9, -18))
    quad(1, madrid)
    quad(3, stripes(["#0068b3", "#ffffff"], 9, 18))
    quad(2, celta)
    sh = Image.new("L", (W, W), 0); ImageDraw.Draw(sh).ellipse([C[0]-R-40, C[1]-R-10, C[0]+R+40, C[1]+R+70], fill=150)
    img.paste((110, 50, 0, 255), (0, 0), sh.filter(ImageFilter.GaussianBlur(40)))
    d = ImageDraw.Draw(img)
    for pad, col in ((46, INK), (30, "#fff1b8"), (14, INK)):
        d.ellipse([C[0]-R-pad, C[1]-R-pad, C[0]+R+pad, C[1]+R+pad], fill=col)
    img.alpha_composite(disc); d = ImageDraw.Draw(img)
    d.line([C[0]-R, C[1], C[0]+R, C[1]], fill=INK, width=22); d.line([C[0], C[1]-R, C[0], C[1]+R], fill=INK, width=22)
    # brillo suave en el borde superior del disco
    gl = Image.new("L", (W, W), 0); ImageDraw.Draw(gl).chord([C[0]-R*.92, C[1]-R*.97, C[0]+R*.92, C[1]+R*.6], 200, 340, fill=70)
    img.paste((255, 255, 255, 255), (0, 0), gl.filter(ImageFilter.GaussianBlur(14)))
    br = int(R * 0.42)
    d.ellipse([C[0]-br-22, C[1]-br-22, C[0]+br+22, C[1]+br+22], fill=INK)
    ball = Image.new("RGBA", (W, W), (0, 0, 0, 0)); bd = ImageDraw.Draw(ball)
    bd.ellipse([C[0]-br, C[1]-br, C[0]+br, C[1]+br], fill="#ffffff")
    pent = lambda px, py, rr, rot: [(px + rr*math.cos(math.radians(rot + 72*i)), py + rr*math.sin(math.radians(rot + 72*i))) for i in range(5)]
    bd.polygon(pent(C[0], C[1], br*.36, -90), fill=INK)
    for i in range(5):
        a = math.radians(-90 + 72*i + 36); px, py = C[0] + br*.95*math.cos(a), C[1] + br*.95*math.sin(a)
        bd.polygon(pent(px, py, br*.32, -90 + 72*i + 216), fill=INK)
        bd.line([(C[0] + br*.3*math.cos(a), C[1] + br*.3*math.sin(a)), (px, py)], fill=INK, width=14)
    bm = Image.new("L", (W, W), 0); ImageDraw.Draw(bm).ellipse([C[0]-br, C[1]-br, C[0]+br, C[1]+br], fill=255)
    img.paste(ball, (0, 0), bm)
    hl = Image.new("L", (W, W), 0); ImageDraw.Draw(hl).ellipse([C[0]-br*.62, C[1]-br*.78, C[0]-br*.3, C[1]-br*.5], fill=230)
    img.paste((255, 255, 255, 255), (0, 0), hl.filter(ImageFilter.GaussianBlur(4)))
    if ribbon:
        d = ImageDraw.Draw(img)
        by = int(W*.80); bh = int(W*.15); bx0 = int(W*.07); bx1 = W - bx0
        for s in (1, -1):
            xa = bx0 if s == 1 else bx1
            d.polygon([(xa - 30*s, by+20), (xa + 60*s, by+20), (xa + 60*s, by+bh+40), (xa - 30*s, by+bh+40), (xa + 20*s, by+bh/2+30)], fill="#8f1020", outline=INK, width=16)
        d.rounded_rectangle([bx0+40, by, bx1-40, by+bh], radius=28, fill="#e3262f", outline=INK, width=18)
        d.rectangle([bx0+60, by+18, bx1-60, by+bh*.42], fill="#f0525a")
        f = font(int(bh*.78)); txt = "LA PORRA"
        tw = d.textlength(txt, font=f); tx = (W - tw)/2; ty = by + bh*.04
        d.text((tx+8, ty+12), txt, font=f, fill=INK, stroke_width=18, stroke_fill=INK)
        d.text((tx, ty), txt, font=f, fill=INK, stroke_width=16, stroke_fill=INK)
        # letras doradas con degradado y brillo
        tm = Image.new("L", (W, W), 0); ImageDraw.Draw(tm).text((tx, ty), txt, font=f, fill=255)
        gy = np.linspace(0, 1, W)[:, None] * np.ones((1, W))
        t0, t1 = (by) / W, (by + bh) / W; k = np.clip((gy - t0) / (t1 - t0), 0, 1)
        stops = [(0, (255, 248, 196)), (.35, (255, 214, 92)), (.55, (232, 168, 28)), (1, (176, 112, 8))]
        col = np.zeros((W, W, 3))
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            m = (k >= p0) & (k <= p1); u = ((k - p0) / (p1 - p0))[..., None]
            col = np.where(m[..., None], np.array(c0) + (np.array(c1) - np.array(c0)) * u, col)
        gold = Image.fromarray(col.astype("uint8")).convert("RGBA")
        img.paste(gold, (0, 0), tm)
    return img.resize((S, S), Image.LANCZOS).convert("RGB")
if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icons"
    big = render(1024)
    big.resize((512, 512), Image.LANCZOS).save(f"{out}/icon-512.png", optimize=True)
    big.resize((192, 192), Image.LANCZOS).save(f"{out}/icon-192.png", optimize=True)
    big.resize((180, 180), Image.LANCZOS).save(f"{out}/apple-touch-icon.png", optimize=True)
    # maskable: todo dentro de la zona segura (Android recorta los bordes)
    m = Image.new("RGB", (1024, 1024)); m.paste(render(1024)); sm = render(1024).resize((760, 760), Image.LANCZOS)
    bg = render(1024).filter(ImageFilter.GaussianBlur(30)); bg.paste(sm, (132, 132)); bg.resize((512, 512), Image.LANCZOS).save(f"{out}/icon-maskable-512.png", optimize=True)
    big.save("/tmp/claude-0/logo/final.png")
