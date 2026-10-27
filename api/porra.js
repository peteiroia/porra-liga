// La Porra · API (Vercel serverless + Upstash Redis REST + Web Push)
//   POST /api/porra            { action, token?, ...datos }
//   GET  /api/porra?avatar=k   foto del jugador
//   GET  /api/porra?cron=1     envía avisos (lo llama GitHub Actions cada 10 min)
const crypto = require("crypto");
let CAL = null;
try { CAL = require("../data/calendario.json"); } catch (e) { /* sin calendario */ }
let webpush = null;
try { webpush = require("web-push"); } catch (e) { /* sin avisos en local */ }

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const P = "porra:";
const SESSION_TTL = 60 * 60 * 24 * 365 * 10; // la sesión no caduca (se renueva con cada uso)
const CLOSE_BEFORE = 60 * 1000;             // se cierra 1 minuto antes del inicio
const OPEN_BEFORE = 7 * 24 * 3600 * 1000;   // se abre como máximo 7 días antes
const REMIND_BEFORE = 60 * 60 * 1000;       // aviso si falta 1 hora y no has pronosticado

let redisImpl = async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
};
const redis = (cmd) => redisImpl(cmd);

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };

const normName = (n) => String(n || "").trim().replace(/\s+/g, " ");
const keyName = (n) => normName(n).toLowerCase();
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e);
const displayOf = (u) => u.display || u.username || u.name;

// Correo para recuperar contraseña (Gmail con contraseña de aplicación)
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch (e) {}
async function sendMail(to, subject, text) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!nodemailer || !user || !pass) return false;
  const t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await t.sendMail({ from: `"La Porra" <${user}>`, to, subject, text });
  return true;
}

async function getJSON(key, def) {
  const v = await redis(["GET", key]);
  if (!v) return def;
  try { return JSON.parse(v); } catch (e) { return def; }
}
const setJSON = (key, val) => redis(["SET", key, JSON.stringify(val)]);
const getUser = (name) => getJSON(P + "user:" + keyName(name), null);

function hgetallObj(raw) {
  const out = {};
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  else if (raw && typeof raw === "object") Object.assign(out, raw);
  for (const k in out) { try { out[k] = JSON.parse(out[k]); } catch (e) { out[k] = null; } }
  return out;
}

async function auth(token) {
  if (!token || typeof token !== "string" || token.length > 100) throw new HttpError(401, "Inicia sesión");
  const k = await redis(["GET", P + "session:" + token]);
  if (!k) throw new HttpError(401, "Sesión caducada, vuelve a entrar");
  redis(["EXPIRE", P + "session:" + token, String(SESSION_TTL)]).catch(() => {});
  const u = await getUser(k);
  if (!u) throw new HttpError(401, "Usuario no encontrado");
  return u;
}
async function newSession(u) {
  const t = crypto.randomBytes(24).toString("hex");
  await redis(["SET", P + "session:" + t, keyName(u.username), "EX", String(SESSION_TTL)]);
  return t;
}

// ---------- Reglas ----------
const sign = (h, a) => (h > a ? "1" : h < a ? "2" : "X");
function points(pred, res) {
  if (!pred || !res) return 0;
  if (pred.h === res.h && pred.a === res.a) return 3;
  return sign(pred.h, pred.a) === sign(res.h, res.a) ? 1 : 0;
}
const isLocked = (m, now) => !!m.result || (!!m.kickoff && Date.parse(m.kickoff) - CLOSE_BEFORE <= now);
// Jornada en juego = la de número más bajo que aún tiene algún partido sin cerrar
function currentJornadaId(jornadas, now) {
  const open = jornadas.filter((j) => j.matches.some((m) => !isLocked(m, now))).sort((a, b) => a.num - b.num);
  return open.length ? open[0].id : null;
}
// open | soon (aún no han pasado a faltar 7 días) | next (no es la jornada siguiente) | closed
function matchStatus(j, m, now, curId) {
  if (isLocked(m, now)) return "closed";
  if (j.id !== curId) return "next";
  if (m.tbc) return "tbc"; // hora por confirmar: no se abre hasta saber la hora
  if (!m.kickoff || Date.parse(m.kickoff) - OPEN_BEFORE > now) return "soon";
  return "open";
}
function goals(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) bad("Marcador no válido");
  return n;
}

// ---------- Calendario oficial (data/calendario.json) ----------
// Se fusiona con lo guardado cada vez que cambia la versión del archivo:
// crea jornadas y partidos que falten, actualiza horas y pone resultados.
// Nunca borra partidos añadidos a mano por el administrador.
const sameTeams = (a, b) => keyName(a.home) === keyName(b.home) && keyName(a.away) === keyName(b.away);
async function syncCalendar(force) {
  if (!CAL || !Array.isArray(CAL.jornadas)) return false;
  if (!force && (await redis(["GET", P + "calver"])) === CAL.version) return false;
  const jornadas = await getJSON(P + "jornadas", []);
  for (const cj of CAL.jornadas) {
    let j = jornadas.find((x) => x.num === cj.num);
    if (!j) { j = { id: crypto.randomBytes(5).toString("hex"), num: cj.num, title: cj.title || "", matches: [] }; jornadas.push(j); }
    for (const cm of cj.matches) {
      let m = j.matches.find((x) => sameTeams(x, cm));
      if (!m) { m = { id: crypto.randomBytes(5).toString("hex"), home: cm.home, away: cm.away }; j.matches.push(m); }
      if (!m.manual) { m.kickoff = new Date(cm.kickoff).toISOString(); m.tbc = !!cm.tbc; }
      if (cm.result && !m.result) m.result = { h: Number(cm.result.h), a: Number(cm.result.a) };
    }
    j.matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  }
  await setJSON(P + "jornadas", jornadas);
  await redis(["SET", P + "calver", CAL.version]);
  return true;
}

async function loadAll() {
  await syncCalendar();
  const [jornadas, predsRaw, userKeys, crestsRaw] = await Promise.all([
    getJSON(P + "jornadas", []),
    redis(["HGETALL", P + "preds"]),
    redis(["SMEMBERS", P + "users"]),
    redis(["HGETALL", P + "crests"]),
  ]);
  const crests = hgetallObj(crestsRaw);
  const preds = hgetallObj(predsRaw);
  const users = [];
  for (const k of userKeys || []) {
    const u = await getUser(k);
    if (u) users.push({ key: k, name: displayOf(u), username: u.username, admin: !!u.admin, photo: u.photo || 0 });
  }
  return { jornadas, preds, users, crests };
}

function buildState(me, data) {
  const now = Date.now();
  const myKey = keyName(me.username);
  const { jornadas, preds, users, crests } = data;
  jornadas.sort((a, b) => a.num - b.num);
  const photo = Object.fromEntries(users.map((u) => [u.name, u.photo ? u.key + "&v=" + u.photo : null]));

  const table = users.map((u) => ({ name: u.name, key: u.key, pts: 0, exact: 0, signs: 0, played: 0, byJ: {} }));
  const byKey = Object.fromEntries(table.map((r) => [r.key, r]));
  for (const j of jornadas) {
    for (const r of table) r.byJ[j.id] = 0;
    for (const m of j.matches) {
      if (!m.result) continue;
      for (const r of table) {
        const p = (preds[r.key] || {})[m.id];
        if (!p) continue;
        const pt = points(p, m.result);
        r.byJ[j.id] += pt; r.pts += pt; r.played++;
        if (pt === 3) r.exact++; else if (pt === 1) r.signs++;
      }
    }
  }
  const doneJ = jornadas.filter((j) => j.matches.some((m) => m.result));
  const lastJ = doneJ[doneJ.length - 1];
  const cmp = (a, b, f) => f(b) - f(a) || b.exact - a.exact || a.name.localeCompare(b.name);
  table.sort((a, b) => cmp(a, b, (r) => r.pts));
  table.forEach((r, i) => (r.pos = i + 1));
  if (lastJ) {
    [...table].sort((a, b) => cmp(a, b, (r) => r.pts - (r.byJ[lastJ.id] || 0)))
      .forEach((r, i) => (byKey[r.key].prevPos = i + 1));
  }

  const curId = currentJornadaId(jornadas, now);
  const outJ = jornadas.map((j) => ({
    id: j.id, num: j.num, title: j.title || "", current: j.id === curId,
    matches: j.matches.map((m) => {
      const locked = isLocked(m, now);
      // Los pronósticos de los demás solo se ven cuando el partido ha empezado
      const started = !!m.result || (!!m.kickoff && Date.parse(m.kickoff) <= now);
      const others = {};
      if (started) {
        for (const u of users) {
          const p = (preds[u.key] || {})[m.id];
          if (p) others[u.name] = { h: p.h, a: p.a, pts: m.result ? points(p, m.result) : null };
        }
      }
      const ko = m.kickoff ? Date.parse(m.kickoff) : null;
      return {
        id: m.id, home: m.home, away: m.away, kickoff: m.kickoff || null, result: m.result || null, tbc: !!m.tbc,
        locked, started, status: matchStatus(j, m, now, curId),
        opensAt: ko && ko - OPEN_BEFORE, closesAt: ko && ko - CLOSE_BEFORE,
        mine: (preds[myKey] || {})[m.id] || null, others,
        count: users.filter((u) => (preds[u.key] || {})[m.id]).length,
      };
    }),
  }));

  return {
    me: { name: displayOf(me), username: me.username, email: me.email, admin: !!me.admin, photo: photo[displayOf(me)], profileDone: !!me.display },
    now,
    jornadas: outJ,
    table: table.map(({ key, ...r }) => ({ ...r, photo: photo[r.name] })),
    users: users.map((u) => ({ name: u.name, admin: u.admin, photo: photo[u.name], ...(me.admin ? { username: u.username } : {}) })),
    crests: crests || {},
    rules: { openDays: OPEN_BEFORE / 864e5, closeMin: CLOSE_BEFORE / 6e4, remindMin: REMIND_BEFORE / 6e4 },
  };
}

function cleanMatches(list) {
  if (!Array.isArray(list) || !list.length) bad("Añade al menos un partido");
  if (list.length > 10) bad("Demasiados partidos");
  return list.map((m) => {
    const home = normName(m.home).slice(0, 40), away = normName(m.away).slice(0, 40);
    if (!home || !away) bad("Falta un equipo en algún partido");
    if (home.toLowerCase() === away.toLowerCase()) bad("Un equipo no puede jugar contra sí mismo");
    if (!m.kickoff) bad("Pon la fecha y hora de cada partido");
    const t = Date.parse(m.kickoff);
    if (isNaN(t)) bad("Fecha no válida");
    const out = { id: m.id && /^[a-z0-9]{6,20}$/.test(m.id) ? m.id : crypto.randomBytes(5).toString("hex"), home, away, kickoff: new Date(t).toISOString() };
    if (m.result) out.result = { h: goals(m.result.h), a: goals(m.result.a) };
    return out;
  });
}

// Foto: data URL JPEG/PNG/WebP ya reducida en el móvil (máx ~150 KB)
async function savePhoto(u, dataUrl) {
  const mt = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!mt) bad("Imagen no válida");
  if (mt[2].length > 200000) bad("La imagen es demasiado grande");
  await redis(["SET", P + "avatar:" + keyName(u.username), dataUrl]);
  u.photo = Date.now();
  await setJSON(P + "user:" + keyName(u.username), u);
}

// ---------- Avisos push ----------
async function vapid() {
  let k = await getJSON(P + "vapid", null);
  if (!k && webpush) {
    k = webpush.generateVAPIDKeys();
    const ok = await redis(["SET", P + "vapid", JSON.stringify(k), "NX"]);
    if (!ok) k = await getJSON(P + "vapid", null);
  }
  return k;
}
async function sendPush(userKey, payload) {
  const k = await vapid();
  if (!k || !webpush) return 0;
  webpush.setVapidDetails("mailto:porra@example.com", k.publicKey, k.privateKey);
  const subs = (hgetallObj(await redis(["HGETALL", P + "push"]))[userKey]) || [];
  let sent = 0;
  const keep = [];
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); sent++; keep.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); }
  }
  if (keep.length !== subs.length) await redis(["HSET", P + "push", userKey, JSON.stringify(keep)]);
  return sent;
}
async function runReminders() {
  const now = Date.now();
  const { jornadas, preds, users } = await loadAll();
  const curId = currentJornadaId(jornadas, now);
  const subs = hgetallObj(await redis(["HGETALL", P + "push"]));
  let sent = 0;
  for (const j of jornadas) {
    for (const m of j.matches) {
      if (matchStatus(j, m, now, curId) !== "open") continue;
      const ko = Date.parse(m.kickoff);
      if (ko - now > REMIND_BEFORE) continue;
      for (const u of users) {
        if (!(subs[u.key] || []).length) continue;
        if ((preds[u.key] || {})[m.id]) continue;
        const once = await redis(["SET", P + "reminded:" + m.id + ":" + u.key, "1", "NX", "EX", "172800"]);
        if (!once) continue;
        const mins = Math.max(1, Math.round((ko - now) / 60000));
        sent += await sendPush(u.key, {
          title: "⚽ ¡Te falta un pronóstico!",
          body: `${m.home} – ${m.away} empieza en ${mins} min. Rellena tu resultado antes de que cierre.`,
          tag: "porra-" + m.id,
          url: "./#jornada",
        });
      }
    }
  }
  return sent;
}

// ---------- Acciones ----------
async function handle(body) {
  const a = body.action;

  if (a === "register") {
    const username = normName(body.username);
    const pass = String(body.pass || "");
    if (username.length < 3 || username.length > 20) bad("El usuario debe tener entre 3 y 20 caracteres");
    if (!/^[\p{L}\p{N} ._-]+$/u.test(username) || username.includes("@")) bad("Usa solo letras, números, espacios, punto o guion");
    const email = "";
    if (pass.length < 6) bad("La contraseña debe tener al menos 6 caracteres");
    const k = keyName(username);
    if (await redis(["GET", P + "user:" + k])) bad("Ese usuario ya existe. Elige otro.");
    const salt = crypto.randomBytes(12).toString("hex");
    const count = await redis(["SCARD", P + "users"]);
    const user = { username, email, salt, hash: hashPass(pass, salt), admin: !count, created: Date.now(), photo: 0, display: "" };
    const ok = await redis(["SET", P + "user:" + k, JSON.stringify(user), "NX"]);
    if (!ok) bad("Ese usuario ya existe. Elige otro.");
    await redis(["SADD", P + "users", k]);
    return { token: await newSession(user), admin: user.admin };
  }

  if (a === "login") {
    const id = String(body.username || body.email || "").trim();
    let k = keyName(id);
    if (id.includes("@")) k = (await redis(["GET", P + "email:" + normEmail(id)])) || "";
    const u = k && (await getUser(k));
    if (!u || hashPass(body.pass || "", u.salt) !== u.hash) bad("Usuario o contraseña incorrectos. Si la olvidaste, pide al administrador una nueva.");
    return { token: await newSession(u), admin: !!u.admin };
  }

  // Recuperar contraseña: 1) pide código por correo  2) código + nueva contraseña
  if (a === "forgot") {
    const email = normEmail(body.email);
    const k = validEmail(email) && (await redis(["GET", P + "email:" + email]));
    if (k) {
      const tries = await redis(["INCR", P + "forgotrl:" + email]);
      if (tries === 1) await redis(["EXPIRE", P + "forgotrl:" + email, "3600"]);
      if (tries > 5) bad("Demasiados intentos. Prueba dentro de una hora.");
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      await redis(["SET", P + "reset:" + email, JSON.stringify({ k, code, n: 0 }), "EX", "900"]);
      const u = await getUser(k);
      const sent = await sendMail(email, "Tu código para La Porra: " + code,
        `Hola ${displayOf(u)},\n\nTu código para cambiar la contraseña de La Porra es: ${code}\n\nCaduca en 15 minutos. Tu usuario es: ${u.username}\n\nSi no lo has pedido tú, ignora este correo.`);
      if (!sent) bad("El envío de correos no está configurado todavía. Pide al administrador que te cambie la contraseña.");
    }
    return { ok: true }; // misma respuesta exista o no el correo
  }
  if (a === "reset") {
    const email = normEmail(body.email);
    const r = await getJSON(P + "reset:" + email, null);
    if (!r) bad("El código ha caducado. Pide uno nuevo.");
    if (String(body.code || "").trim() !== r.code) {
      r.n++;
      if (r.n >= 5) await redis(["DEL", P + "reset:" + email]);
      else await redis(["SET", P + "reset:" + email, JSON.stringify(r), "KEEPTTL"]);
      bad("Código incorrecto");
    }
    const pass = String(body.pass || "");
    if (pass.length < 6) bad("La contraseña debe tener al menos 6 caracteres");
    const u = await getUser(r.k);
    if (!u) bad("Usuario no encontrado");
    u.salt = crypto.randomBytes(12).toString("hex");
    u.hash = hashPass(pass, u.salt);
    await setJSON(P + "user:" + r.k, u);
    await redis(["DEL", P + "reset:" + email]);
    return { token: await newSession(u), admin: !!u.admin };
  }

  if (a === "cron") return { sent: await runReminders() };
  if (a === "vapid") { const k = await vapid(); return { publicKey: k ? k.publicKey : null }; }

  const me = await auth(body.token);

  if (a === "logout") { await redis(["DEL", P + "session:" + body.token]); return { ok: true }; }
  if (a === "state") return buildState(me, await loadAll());

  if (a === "photo") { await savePhoto(me, body.photo); return buildState(me, await loadAll()); }

  // Nombre de participante (el que ven los demás) + foto/logo
  if (a === "profile") {
    const display = normName(body.display);
    if (display.length < 2 || display.length > 20) bad("El nombre debe tener entre 2 y 20 caracteres");
    if (!/^[\p{L}\p{N} ._'-]+$/u.test(display)) bad("Usa solo letras, números y espacios");
    const { users } = await loadAll();
    if (users.some((x) => x.key !== keyName(me.username) && x.name.toLowerCase() === display.toLowerCase())) bad("Ese nombre ya lo usa otro participante");
    me.display = display;
    await setJSON(P + "user:" + keyName(me.username), me);
    if (body.photo) await savePhoto(me, body.photo);
    return buildState(me, await loadAll());
  }

  if (a === "changePass") {
    if (hashPass(body.old || "", me.salt) !== me.hash) bad("La contraseña actual no es correcta");
    const pass = String(body.pass || "");
    if (pass.length < 6) bad("La contraseña debe tener al menos 6 caracteres");
    me.salt = crypto.randomBytes(12).toString("hex");
    me.hash = hashPass(pass, me.salt);
    await setJSON(P + "user:" + keyName(me.username), me);
    return { ok: true };
  }

  if (a === "subscribe" || a === "unsubscribe") {
    const s = body.sub;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint)) bad("Suscripción no válida");
    const k = keyName(me.username);
    let list = (hgetallObj(await redis(["HGETALL", P + "push"]))[k]) || [];
    list = list.filter((x) => x.endpoint !== s.endpoint);
    if (a === "subscribe") list.push({ endpoint: s.endpoint, keys: s.keys });
    await redis(["HSET", P + "push", k, JSON.stringify(list.slice(-5))]);
    return { ok: true };
  }
  if (a === "testPush") {
    const n = await sendPush(keyName(me.username), { title: "⚽ La Porra", body: "¡Avisos activados! Te avisaremos 1 hora antes si te falta algún pronóstico.", tag: "test", url: "./" });
    return { sent: n };
  }

  if (a === "predict") {
    const jornadas = await getJSON(P + "jornadas", []);
    const j = jornadas.find((x) => x.id === body.jornada);
    if (!j) bad("Jornada no encontrada");
    const now = Date.now();
    const k = keyName(me.username);
    let mine = {};
    try { mine = JSON.parse((await redis(["HGET", P + "preds", k])) || "{}") || {}; } catch (e) { mine = {}; }
    const curId = currentJornadaId(jornadas, now);
    let saved = 0, skipped = 0;
    for (const m of j.matches) {
      const p = body.picks && body.picks[m.id];
      if (!p || p.h === "" || p.a === "" || p.h == null || p.a == null) continue;
      if (matchStatus(j, m, now, curId) !== "open") { skipped++; continue; }
      mine[m.id] = { h: goals(p.h), a: goals(p.a), at: now };
      saved++;
    }
    await redis(["HSET", P + "preds", k, JSON.stringify(mine)]);
    return { saved, skipped, ...buildState(me, await loadAll()) };
  }

  // ---- Solo administradores ----
  if (!me.admin) throw new HttpError(403, "Solo el administrador puede hacer esto");
  const findByDisplay = async (n) => {
    const { users } = await loadAll();
    const x = users.find((q) => q.name.toLowerCase() === normName(n).toLowerCase());
    return x ? await getUser(x.key) : null;
  };
  const jornadas = await getJSON(P + "jornadas", []);

  if (a === "saveJornada") {
    const num = Number(body.num);
    if (!Number.isInteger(num) || num < 1 || num > 60) bad("Número de jornada no válido");
    const matches = cleanMatches(body.matches);
    let j = body.id ? jornadas.find((x) => x.id === body.id) : null;
    if (jornadas.some((x) => x.num === num && (!j || x.id !== j.id))) bad("Ya existe la jornada " + num);
    if (j) {
      const old = Object.fromEntries(j.matches.map((m) => [m.id, m]));
      j.num = num; j.title = normName(body.title).slice(0, 40);
      j.matches = matches.map((m) => {
        const o = old[m.id];
        const out = o && o.result && !m.result ? { ...m, result: o.result } : { ...m };
        // si el admin cambia la hora, queda confirmada y el calendario automático ya no la toca
        if (o && o.kickoff === m.kickoff) { out.tbc = !!o.tbc; out.manual = !!o.manual; }
        else out.manual = true;
        return out;
      });
    } else {
      j = { id: crypto.randomBytes(5).toString("hex"), num, title: normName(body.title).slice(0, 40), matches: matches.map((m) => ({ ...m, manual: true })) };
      jornadas.push(j);
    }
    await setJSON(P + "jornadas", jornadas);
    return buildState(me, await loadAll());
  }

  // Escudo de un equipo (lo sube el administrador)
  if (a === "setCrest") {
    const team = keyName(body.team).slice(0, 40);
    if (!team) bad("Falta el equipo");
    if (body.clear) { await redis(["DEL", P + "crest:" + team]); await redis(["HDEL", P + "crests", team]); }
    else {
      const mt = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo || ""));
      if (!mt || mt[2].length > 200000) bad("Imagen no válida");
      await redis(["SET", P + "crest:" + team, body.photo]);
      await redis(["HSET", P + "crests", team, String(Date.now())]);
    }
    return buildState(me, await loadAll());
  }

  if (a === "syncCalendar") { await syncCalendar(true); return buildState(me, await loadAll()); }

  if (a === "deleteJornada") {
    const i = jornadas.findIndex((x) => x.id === body.id);
    if (i < 0) bad("Jornada no encontrada");
    jornadas.splice(i, 1);
    await setJSON(P + "jornadas", jornadas);
    return buildState(me, await loadAll());
  }

  if (a === "setResult") {
    const j = jornadas.find((x) => x.id === body.jornada);
    const m = j && j.matches.find((x) => x.id === body.match);
    if (!m) bad("Partido no encontrado");
    if (body.clear) delete m.result;
    else {
      if (Date.parse(m.kickoff) > Date.now()) bad("El partido aún no ha empezado");
      m.result = { h: goals(body.h), a: goals(body.a) };
    }
    await setJSON(P + "jornadas", jornadas);
    return buildState(me, await loadAll());
  }

  if (a === "setAdmin") {
    const u = await findByDisplay(body.name);
    if (!u) bad("Usuario no encontrado");
    if (keyName(u.username) === keyName(me.username) && !body.admin) bad("No puedes quitarte el admin a ti mismo");
    u.admin = !!body.admin;
    await setJSON(P + "user:" + keyName(u.username), u);
    return buildState(me, await loadAll());
  }

  if (a === "resetPass") {
    const u = await findByDisplay(body.name);
    if (!u) bad("Usuario no encontrado");
    const pass = String(body.pass || "");
    if (pass.length < 6) bad("La contraseña debe tener al menos 6 caracteres");
    u.salt = crypto.randomBytes(12).toString("hex");
    u.hash = hashPass(pass, u.salt);
    await setJSON(P + "user:" + keyName(u.username), u);
    return { ok: true };
  }

  if (a === "deleteUser") {
    const du = await findByDisplay(body.name);
    if (!du) bad("Usuario no encontrado");
    const k = keyName(du.username);
    if (du.email) await redis(["DEL", P + "email:" + du.email]);
    if (k === keyName(me.username)) bad("No puedes borrarte a ti mismo");
    await redis(["DEL", P + "user:" + k]);
    await redis(["DEL", P + "avatar:" + k]);
    await redis(["SREM", P + "users", k]);
    await redis(["HDEL", P + "preds", k]);
    await redis(["HDEL", P + "push", k]);
    return buildState(me, await loadAll());
  }

  bad("Acción desconocida");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Falta conectar la base de datos (Upstash Redis) en Vercel" });
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      if (q.avatar) {
        const d = await redis(["GET", P + "avatar:" + keyName(q.avatar)]);
        const mt = d && /^data:(image\/\w+);base64,(.+)$/.exec(d);
        if (!mt) return res.status(404).end();
        res.setHeader("Content-Type", mt[1]);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).send(Buffer.from(mt[2], "base64"));
      }
      if (q.crest) {
        const d = await redis(["GET", P + "crest:" + keyName(q.crest)]);
        const mt = d && /^data:(image\/\w+);base64,(.+)$/.exec(d);
        if (!mt) return res.status(404).end();
        res.setHeader("Content-Type", mt[1]);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.status(200).send(Buffer.from(mt[2], "base64"));
      }
      if (q.cron) return res.status(200).json({ sent: await runReminders() });
      return res.status(405).json({ error: "Usa POST" });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    res.status(200).json(await handle(body || {}));
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.code).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Error del servidor" });
  }
};
module.exports._test = { handle, setRedis: (f) => (redisImpl = f), points, runReminders };
