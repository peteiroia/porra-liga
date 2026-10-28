# Icono moderno de La Porra: python3 tools/icono2.py [carpeta] [tema: oro|noche]
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np, math, sys
F_BLACK = "/usr/share/fonts/opentype/inter/InterDisplay-BlackItalic.otf"
def grad_img(W, stops, axis="y", t0=0, t1=1):
    g = np.linspace(0, 1, W)
    k = np.clip((g - t0) / (t1 - t0), 0, 1)
    col = np.zeros((W, 3))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (k >= p0) & (k <= p1); u = ((k - p0) / max(p1 - p0, 1e-6))[:, None]
        col = np.where(m[:, None], np.array(c0) + (np.array(c1) - np.array(c0)) * u, col)
    arr = np.repeat(col[:, None, :], W, 1) if axis == "y" else np.repeat(col[None, :, :], W, 0)
    return Image.fromarray(arr.astype("uint8")).convert("RGBA")
GOLD = [(0, (255, 246, 200)), (.38, (255, 214, 96)), (.6, (232, 166, 30)), (1, (170, 108, 10))]
def render(S=1024, tema="oro"):
    W = S * 2; cx = W / 2
    # --- fondo
    y, x = np.mgrid[0:W, 0:W].astype(float)
    if tema == "oro":
        r = np.hypot(x - W * .35, y - W * .25) / (W * 1.1)
        c1, c2 = np.array((255, 222, 120)), np.array((196, 128, 18))
    else:
        r = np.hypot(x - W * .5, y - W * .3) / (W * 1.0)
        c1, c2 = np.array((40, 62, 96)), np.array((10, 16, 30))
    base = c1 + (c2 - c1) * np.clip(r, 0, 1)[..., None]
    img = Image.fromarray(base.astype("uint8")).convert("RGBA")
    if tema == "noche":  # halo dorado detrás del disco
        halo = Image.new("L", (W, W), 0); ImageDraw.Draw(halo).ellipse([W*.12, W*.06, W*.88, W*.82], fill=120)
        img.paste((245, 190, 60, 255), (0, 0), halo.filter(ImageFilter.GaussianBlur(W * .08)))
    R = int(W * .335); C = (W // 2, int(W * .44))
    # sombra suave
    sh = Image.new("L", (W, W), 0); ImageDraw.Draw(sh).ellipse([C[0]-R, C[1]-R+W*.035, C[0]+R, C[1]+R+W*.035], fill=150)
    img.paste((60, 30, 0, 255) if tema == "oro" else (0, 0, 0, 255), (0, 0), sh.filter(ImageFilter.GaussianBlur(W * .03)))
    # --- disco: 4 cuartos con los colores, separados por un hueco fino
    disc = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    def quad(q, fn):
        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0)); fn(ImageDraw.Draw(layer))
        m = Image.new("L", (W, W), 0); a0 = {0: 180, 1: 270, 2: 0, 3: 90}[q]
        ImageDraw.Draw(m).pieslice([C[0]-R, C[1]-R, C[0]+R, C[1]+R], a0, a0 + 90, fill=255)
        disc.paste(layer, (0, 0), m)
    def stripes(cols, n, ang):
        def fn(ld):
            w = 2 * R / n; t = math.tan(math.radians(ang)) * W
            for i in range(-2 * n, 3 * n):
                x0 = C[0] - R + i * w
                ld.polygon([(x0, 0), (x0 + w, 0), (x0 + w + t, W), (x0 + t, W)], fill=cols[i % len(cols)])
        return fn
    def bands(bg, bs):
        def fn(ld):
            ld.rectangle([0, 0, W, W], fill=bg)
            for (y0, h, c) in bs:
                ld.polygon([(C[0]-R, C[1] + R*y0 + R*.25), (C[0]+R, C[1] + R*y0 - R*.25), (C[0]+R, C[1] + R*(y0+h) - R*.25), (C[0]-R, C[1] + R*(y0+h) + R*.25)], fill=c)
        return fn
    quad(0, stripes(["#a50044", "#004d98"], 11, -12))                                   # Barça
    quad(1, bands("#f7f7fb", [(-.62, .1, "#febe10"), (-.5, .08, "#4b3a9c")]))            # Madrid
    quad(3, stripes(["#0a6fbe", "#f7f7fb"], 11, 12))                                    # Depor
    quad(2, bands("#8fcbf0", [(.5, .1, "#f7f7fb"), (.6, .07, "#e30613")]))              # Celta
    # huecos finos entre cuartos
    gd = ImageDraw.Draw(disc); gap = int(W * .012)
    gd.line([C[0]-R, C[1], C[0]+R, C[1]], fill=(0, 0, 0, 0), width=gap); gd.line([C[0], C[1]-R, C[0], C[1]+R], fill=(0, 0, 0, 0), width=gap)
    # aros: fino azul grisáceo + fino rojo + borde dorado
    d = ImageDraw.Draw(img)
    rings = [(.105, (46, 58, 78)), (.085, (255, 226, 130)), (.07, (90, 108, 134)), (.05, (226, 38, 47)), (.034, (90, 108, 134)), (.022, (250, 250, 252))]
    for pad, col in rings:
        p = W * pad * .5
        d.ellipse([C[0]-R-p, C[1]-R-p, C[0]+R+p, C[1]+R+p], fill=col)
    img.alpha_composite(disc)
    # brillo diagonal muy sutil
    gl = Image.new("L", (W, W), 0); ImageDraw.Draw(gl).pieslice([C[0]-R, C[1]-R, C[0]+R, C[1]+R], 200, 290, fill=38)
    img.paste((255, 255, 255, 255), (0, 0), gl.filter(ImageFilter.GaussianBlur(W * .01)))
    # --- balón minimalista
    br = int(R * .40); d = ImageDraw.Draw(img)
    sh2 = Image.new("L", (W, W), 0); ImageDraw.Draw(sh2).ellipse([C[0]-br, C[1]-br+W*.012, C[0]+br, C[1]+br+W*.012], fill=140)
    img.paste((0, 0, 0, 255), (0, 0), sh2.filter(ImageFilter.GaussianBlur(W * .012)))
    d.ellipse([C[0]-br-W*.012, C[1]-br-W*.012, C[0]+br+W*.012, C[1]+br+W*.012], fill=(46, 58, 78))
    ball = Image.new("RGBA", (W, W), (0, 0, 0, 0)); bd = ImageDraw.Draw(ball)
    bd.ellipse([C[0]-br, C[1]-br, C[0]+br, C[1]+br], fill="#ffffff")
    pent = lambda px, py, rr, rot: [(px + rr*math.cos(math.radians(rot + 72*i)), py + rr*math.sin(math.radians(rot + 72*i))) for i in range(5)]
    INK = (30, 38, 54)
    bd.polygon(pent(C[0], C[1], br*.34, -90), fill=INK)
    for i in range(5):
        a = math.radians(-90 + 72*i + 36); px, py = C[0] + br*.98*math.cos(a), C[1] + br*.98*math.sin(a)
        bd.polygon(pent(px, py, br*.3, -90 + 72*i + 216), fill=INK)
        bd.line([(C[0] + br*.3*math.cos(a), C[1] + br*.3*math.sin(a)), (px - br*.2*math.cos(a), py - br*.2*math.sin(a))], fill=INK, width=int(W*.006))
    # sombreado esférico
    yy, xx = np.mgrid[0:W, 0:W].astype(float); dd = np.hypot(xx - (C[0] - br*.35), yy - (C[1] - br*.4)) / (br * 1.9)
    shade = Image.fromarray((np.clip(dd, 0, 1) ** 2 * 90).astype("uint8"))
    ball_shaded = ball.copy(); dark = Image.new("RGBA", (W, W), (20, 28, 46, 255))
    ball_shaded.paste(dark, (0, 0), shade)
    bm = Image.new("L", (W, W), 0); ImageDraw.Draw(bm).ellipse([C[0]-br, C[1]-br, C[0]+br, C[1]+br], fill=255)
    img.paste(ball_shaded, (0, 0), bm)
    # --- cinta estilizada azul grisácea con letras doradas
    d = ImageDraw.Draw(img)
    by = int(W * .765); bh = int(W * .13); bx0 = int(W * .1); bx1 = W - bx0; fold = W * .045
    slate, slate_d = (58, 72, 96), (34, 44, 62)
    for s in (1, -1):  # colas con muesca
        xa = bx0 if s == 1 else bx1
        d.polygon([(xa - fold*1.4*s, by + fold), (xa + fold*s, by + fold), (xa + fold*s, by + bh + fold), (xa - fold*1.4*s, by + bh + fold), (xa - fold*.6*s, by + bh/2 + fold)], fill=slate_d)
        d.polygon([(xa + fold*s, by + bh), (xa + fold*s, by + bh + fold), (xa + fold*2*s, by + bh)], fill=(22, 28, 40))
    rb = grad_img(W, [(0, (92, 110, 140)), (.5, slate), (1, slate_d)], "y", by / W, (by + bh) / W)
    rm = Image.new("L", (W, W), 0); ImageDraw.Draw(rm).rounded_rectangle([bx0 + fold, by, bx1 - fold, by + bh], radius=int(bh*.18), fill=255)
    img.paste(rb, (0, 0), rm)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([bx0 + fold, by, bx1 - fold, by + bh], radius=int(bh*.18), outline=(255, 214, 96), width=int(W*.005))
    f = ImageFont.truetype(F_BLACK, int(bh * .72)); txt = "LA PORRA"
    tw = d.textlength(txt, font=f); bb = d.textbbox((0, 0), txt, font=f)
    tx = (W - tw) / 2; ty = by + (bh - (bb[3] - bb[1])) / 2 - bb[1]
    d.text((tx + W*.004, ty + W*.006), txt, font=f, fill=(16, 20, 30))
    tm = Image.new("L", (W, W), 0); ImageDraw.Draw(tm).text((tx, ty), txt, font=f, fill=255)
    img.paste(grad_img(W, GOLD, "y", (ty + bb[1]) / W, (ty + bb[3]) / W), (0, 0), tm)
    return img.resize((S, S), Image.LANCZOS).convert("RGB")
if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icons"; tema = sys.argv[2] if len(sys.argv) > 2 else "oro"
    big = render(1024, tema)
    if out == "-":
        big.save(f"/tmp/claude-0/logo/{tema}.png"); sys.exit()
    big.resize((512, 512), Image.LANCZOS).save(f"{out}/icon-512.png", optimize=True)
    big.resize((192, 192), Image.LANCZOS).save(f"{out}/icon-192.png", optimize=True)
    big.resize((180, 180), Image.LANCZOS).save(f"{out}/apple-touch-icon.png", optimize=True)
    bg = big.filter(ImageFilter.GaussianBlur(40)); bg.paste(big.resize((760, 760), Image.LANCZOS), (132, 132))
    bg.resize((512, 512), Image.LANCZOS).save(f"{out}/icon-maskable-512.png", optimize=True)
    big.save(f"/tmp/claude-0/logo/{tema}.png")
