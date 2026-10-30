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
// Partidos de oro (valen doble): el Clásico y el derbi gallego
const COMODINES = 3;
const RETOS = 10;          // retos por jugador en toda la temporada
const RETOS_MISMO = 2;     // máximo de retos a la misma persona
// Plazo para retar: hasta 1 minuto antes del primer partido de la jornada
const retoDeadline = (j) => Math.min(...j.matches.filter((m) => !m.cancelled).map((m) => Date.parse(m.kickoff))) - CLOSE_BEFORE;
const clubKey = (n) => {
  const t = String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/real madrid/.test(t)) return "madrid";
  if (/barcelona|barca/.test(t) && !/espanyol/.test(t)) return "barca";
  if (/deportivo|coruna/.test(t) && !/alaves/.test(t)) return "depor";
  if (/celta/.test(t)) return "celta";
  return null;
};
function goldenOf(m) {
  const pair = [clubKey(m.home), clubKey(m.away)].sort().join("-");
  if (pair === "barca-madrid") return "Clásico";
  if (pair === "celta-depor") return "Derbi gallego";
  return null;
}
// Puntos finales de un pronóstico:
//   base (3 exacto · 1 signo · 0) × 2 si es partido de oro o si usó comodín (no se acumulan)
//   + 1 extra si fue el ÚNICO en acertar el resultado exacto de ese partido
function scoreFor(p, m, exactCount, extra) {
  if (!p || !m.result) return null;
  const base = points(p, m.result);
  const mult = goldenOf(m) ? 2 : p.x2 ? 2 : 1; // el comodín no se suma en partidos de oro
  const unique = !extra && base === 3 && exactCount === 1 ? 1 : 0;
  // puntos que ha dado el comodín (solo si acertó algo; en partidos de oro no hay comodín)
  const comodin = p.x2 && !goldenOf(m) ? base : 0;
  return { base, pts: base * mult + unique, mult, unique: !!unique, comodin };
}
const exactCountOf = (m, users, preds) =>
  m.result ? users.filter((u) => { const p = (preds[u.key] || {})[m.id]; return p && p.h === m.result.h && p.a === m.result.a; }).length : 0;
// Partidos aplazados = anulados: no puntúan ni cuentan para nada
const live = (j) => j.matches.filter((m) => !m.cancelled);
const jEnd = (j) => Math.max(...live(j).map((m) => Date.parse(m.kickoff) || 0), 0);
const allDone = (j) => live(j).length > 0 && live(j).every((m) => m.result);
const isLocked = (m, now) => !!m.cancelled || !!m.result || (!!m.kickoff && Date.parse(m.kickoff) - CLOSE_BEFORE <= now);
// Jornada en juego = la de número más bajo que aún tiene algún partido sin cerrar
// (las jornadas extra van por libre y no cuentan aquí)
const firstKo = (j) => Math.min(...j.matches.map((m) => Date.parse(m.kickoff) || Infinity));
function currentJornadaId(jornadas, now) {
  const nextKo = (j) => Math.min(...j.matches.filter((m) => !isLocked(m, now)).map((m) => Date.parse(m.kickoff) || Infinity));
  const open = jornadas.filter((j) => !j.extra && j.matches.some((m) => !isLocked(m, now))).sort((a, b) => nextKo(a) - nextKo(b) || a.num - b.num);
  return open.length ? open[0].id : null;
}
// open | soon (aún no han pasado a faltar 7 días) | next (no es la jornada siguiente) | closed
function matchStatus(j, m, now, curId) {
  if (m.cancelled) return "cancelled";
  if (isLocked(m, now)) return "closed";
  if (!j.extra && j.id !== curId) return "next";
  if (m.tbc) return "tbc"; // hora por confirmar: no se abre hasta saber la hora
  if (!m.kickoff || Date.parse(m.kickoff) - OPEN_BEFORE > now) return "soon";
  return "open";
}
function goals(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) bad("Marcador no válido");
  return n;
}

// ---------- Mes de la tortilla ----------
// Cada periodo termina el ÚLTIMO MIÉRCOLES del mes a las 23:59:59 (hora de Madrid).
// Los dos últimos (y los empatados con el penúltimo o por debajo) traen tortilla el viernes siguiente.
function madridOffsetMin(ms) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "shortOffset" }).formatToParts(new Date(ms));
    const tz = (p.find((x) => x.type === "timeZoneName") || {}).value || "GMT+1";
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(tz); return m ? Number(m[1]) * 60 + (m[1].startsWith("-") ? -1 : 1) * Number(m[2] || 0) : 60;
  } catch (e) { return 60; }
}
function lastWednesday(y, m) { // m: 0-11
  const last = new Date(Date.UTC(y, m + 1, 0)); const d = last.getUTCDate() - ((last.getUTCDay() - 3 + 7) % 7);
  return d;
}
function cutMs(y, m) { // fin del periodo (y, m)
  const d = lastWednesday(y, m); const guess = Date.UTC(y, m, d, 23, 59, 59);
  return guess - madridOffsetMin(guess) * 60000;
}
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function periodOf(ms) {
  const d = new Date(ms + madridOffsetMin(ms) * 60000); let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (ms > cutMs(y, m)) { m++; if (m > 11) { m = 0; y++; } }
  return { id: `${y}-${String(m + 1).padStart(2, "0")}`, y, m };
}
function periodInfo(y, m) {
  const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
  const to = cutMs(y, m), from = cutMs(py, pm) + 1000, friday = to + 2 * 864e5;
  return { id: `${y}-${String(m + 1).padStart(2, "0")}`, label: `${MESES[m]} ${y}`, from, to, friday };
}

// ---------- Recolocar partidos por fecha ----------
// Si un partido se adelanta o se retrasa, pasa a la jornada de Liga cuya fecha
// (mediana de sus partidos) quede más cerca. Las jornadas extra no se tocan.
function regroup(jornadas) {
  const liga = jornadas.filter((j) => !j.extra);
  const med = (arr) => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const center = {};
  for (const j of liga) center[j.id] = med(j.matches.filter((m) => !m.cancelled && !m.movedFrom).map((m) => Date.parse(m.kickoff)).filter(Boolean))
    ?? med(j.matches.map((m) => Date.parse(m.kickoff)).filter(Boolean));
  const DAY = 864e5;
  for (const j of liga) {
    for (const m of j.matches.slice()) {
      const t = Date.parse(m.kickoff); if (!t || m.cancelled || m.result) continue;
      let best = j, bd = Math.abs(t - (center[j.id] ?? t));
      for (const o of liga) { if (center[o.id] == null) continue; const dd = Math.abs(t - center[o.id]); if (dd + 2 * DAY < bd) { best = o; bd = dd; } }
      if (best !== j) {
        j.matches = j.matches.filter((x) => x !== m);
        m.movedFrom = m.movedFrom || j.num;
        if (m.movedFrom === best.num) delete m.movedFrom;
        best.matches.push(m); best.matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      }
    }
  }
  return jornadas;
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
      if (!m) { for (const o of jornadas) { const f = o.matches.find((x) => sameTeams(x, cm) && x.movedFrom === cj.num); if (f) { m = f; break; } } }
      if (!m) { m = { id: crypto.randomBytes(5).toString("hex"), home: cm.home, away: cm.away }; j.matches.push(m); }
      if (cm.postponed) m.cancelled = true;
      if (!m.manual) { m.kickoff = new Date(cm.kickoff).toISOString(); m.tbc = !!cm.tbc; }
      if (cm.result && !m.result) m.result = { h: Number(cm.result.h), a: Number(cm.result.a) };
    }
    j.matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  }
  regroup(jornadas);
  await setJSON(P + "jornadas", jornadas);
  await redis(["SET", P + "calver", CAL.version]);
  return true;
}

async function migrations() {
  // Reinicio de retos pedido por el administrador (se ejecuta una sola vez)
  const ok = await redis(["SET", P + "mig:retosReset1", String(Date.now()), "NX"]);
  if (ok) await redis(["DEL", P + "retos"]);
}
async function loadAll() {
  await migrations();
  await syncCalendar();
  const [jornadas, predsRaw, userKeys, crestsRaw, retos, anuncio] = await Promise.all([
    getJSON(P + "jornadas", []),
    redis(["HGETALL", P + "preds"]),
    redis(["SMEMBERS", P + "users"]),
    redis(["HGETALL", P + "crests"]),
    getJSON(P + "retos", []),
    getJSON(P + "anuncio", null),
  ]);
  const crests = hgetallObj(crestsRaw);
  const preds = hgetallObj(predsRaw);
  const users = [];
  for (const k of userKeys || []) {
    const u = await getUser(k);
    if (u) users.push({ key: k, name: displayOf(u), username: u.username, admin: !!u.admin, photo: u.photo || 0, bonusX2: u.bonusX2 || 0 });
  }
  return { jornadas, preds, users, crests, retos, anuncio };
}

function buildState(me, data) {
  const now = Date.now();
  const myKey = keyName(me.username);
  const { jornadas, preds, users, crests } = data;
  const cancelledIds = new Set(jornadas.flatMap((j) => j.matches.filter((m) => m.cancelled).map((m) => m.id)));
  const retos = (data.retos || []).filter((r) => users.some((u) => u.key === r.from) && users.some((u) => u.key === r.to));
  const nameOf = Object.fromEntries(users.map((u) => [u.key, u.name]));
  // orden por fecha (las extra se intercalan donde caigan)
  jornadas.sort((a, b) => (a.extra || b.extra ? firstKo(a) - firstKo(b) : a.num - b.num));
  const photo = Object.fromEntries(users.map((u) => [u.name, u.photo ? u.key + "&v=" + u.photo : null]));

  const table = users.map((u) => ({ name: u.name, key: u.key, pts: 0, exact: 0, signs: 0, played: 0, byJ: {} }));
  const byKey = Object.fromEntries(table.map((r) => [r.key, r]));
  for (const j of jornadas) {
    for (const r of table) r.byJ[j.id] = 0;
    for (const m of j.matches) {
      if (!m.result || m.cancelled) continue;
      const ec = exactCountOf(m, users, preds);
      for (const r of table) {
        const p = (preds[r.key] || {})[m.id];
        if (!p) continue;
        const sc = scoreFor(p, m, ec, j.extra);
        r.byJ[j.id] += sc.pts; r.pts += sc.pts; r.played++;
        { const pid = periodOf(Date.parse(m.kickoff)).id; (r.tm = r.tm || {})[pid] = (r.tm[pid] || 0) + sc.pts; }
        const bd = ((r.bd = r.bd || {})[j.id] = r.bd[j.id] || { partidos: 0, unico: 0, pleno: 0, reto: 0, exactos: 0, signos: 0, comodin: 0 });
        bd.partidos += sc.pts - (sc.unique ? 1 : 0) - sc.comodin; bd.unico += sc.unique ? 1 : 0; bd.comodin = (bd.comodin || 0) + sc.comodin;
        if (sc.base === 3) bd.exactos++; else if (sc.base === 1) bd.signos++;
        if (sc.base === 3) r.exact++; else if (sc.base === 1) r.signs++;
        if (sc.unique) r.unique = (r.unique || 0) + 1;
      }
    }
    // Pleno de jornada (cuando están todos los resultados):
    //   todos los signos acertados → +1 · todos los resultados exactos → +3 (en lugar del +1)
    if (!j.extra && allDone(j)) {
      for (const r of table) {
        const ps = live(j).map((m) => (preds[r.key] || {})[m.id]);
        if (ps.some((p) => !p)) continue;
        const bases = live(j).map((m, i) => points(ps[i], m.result));
        const bonus = bases.every((b) => b === 3) ? 3 : bases.every((b) => b >= 1) ? 1 : 0;
        if (!bonus) continue;
        r.byJ[j.id] += bonus; r.pts += bonus;
        (r.plenos = r.plenos || {})[j.id] = bonus;
        { const pid = periodOf(jEnd(j)).id; (r.tm = r.tm || {})[pid] = (r.tm[pid] || 0) + bonus; }
        ((r.bd = r.bd || {})[j.id] = r.bd[j.id] || { partidos: 0, unico: 0, pleno: 0, reto: 0, exactos: 0, signos: 0 }).pleno += bonus;
      }
    }
  }
  // Retos: cuando la jornada tiene todos los resultados, quien gana el duelo
  // se lleva los puntos de esa jornada del que pierde, y el que pierde se queda
  // con 0 en esa jornada. Empate: cada uno se queda con lo suyo.
  const retoOut = [];
  for (const r of retos) {
    const j = jornadas.find((x) => x.id === r.jornada);
    if (!j) continue;
    const A = byKey[r.from], B = byKey[r.to];
    const done = allDone(j);
    const o = { id: r.id || (r.jornada + ":" + r.from), jornada: j.id, num: j.num, from: nameOf[r.from], to: nameOf[r.to], done, started: now >= retoDeadline(j) };
    if (done && A && B) {
      const pa = A.byJ[j.id] || 0, pb = B.byJ[j.id] || 0;
      o.ptsFrom = pa; o.ptsTo = pb;
      if (pa !== pb) {
        const W = pa > pb ? A : B, L = pa > pb ? B : A, gain = Math.min(pa, pb);
        o.winner = W.name; o.loser = L.name; o.gain = gain;
        W.retoJ = W.retoJ || {}; W.retoJ[j.id] = (W.retoJ[j.id] || 0) + gain;
        W.retoPts = (W.retoPts || 0) + gain;
        L.retoJ = L.retoJ || {}; L.retoJ[j.id] = (L.retoJ[j.id] || 0) - gain;   // el perdedor se queda a 0
        L.retoPts = (L.retoPts || 0) - gain;
        L.lostJ = L.lostJ || {}; L.lostJ[j.id] = true;
        W.retoWins = (W.retoWins || 0) + 1;
      }
    }
    retoOut.push(o);
  }
  for (const r of table) if (r.retoPts) {
    r.pts += r.retoPts;
    for (const jid in r.retoJ) {
      { const jj = jornadas.find((x) => x.id === jid); if (jj) { const pid = periodOf(jEnd(jj)).id; (r.tm = r.tm || {})[pid] = (r.tm[pid] || 0) + r.retoJ[jid]; } }
      r.byJ[jid] += r.retoJ[jid]; ((r.bd = r.bd || {})[jid] = r.bd[jid] || { partidos: 0, unico: 0, pleno: 0, reto: 0, exactos: 0, signos: 0 }).reto += r.retoJ[jid]; }
  }

  const jWinners = {}, jTop = {};
  // Campeón de jornada: el que más puntos hace en cada jornada de Liga terminada (empates cuentan para todos)
  for (const j of jornadas) {
    if (j.extra || !allDone(j)) continue;
    const played = table.filter((r) => live(j).some((m) => (preds[r.key] || {})[m.id]));
    if (!played.length) continue;
    const top = Math.max(...played.map((r) => r.byJ[j.id] || 0));
    if (top <= 0) continue;
    for (const r of played) if ((r.byJ[j.id] || 0) === top) { r.jWins = (r.jWins || 0) + 1; (jWinners[j.id] = jWinners[j.id] || []).push(r.name); jTop[j.id] = top; }
  }

  // Comodín de consolación: el último de cada jornada terminada (entre los que jugaron)
  // gana un comodín x2 extra. Si hay empate en la última plaza, se lo llevan todos;
  // si todos empatan, nadie.
  const extraX2 = {}, lastOf = {};
  for (const j of jornadas) {
    if (j.extra || !allDone(j)) continue;
    const played = table.filter((r) => live(j).some((m) => (preds[r.key] || {})[m.id]));
    if (played.length < 2) continue;
    const pts = played.map((r) => r.byJ[j.id] || 0), min = Math.min(...pts), max = Math.max(...pts);
    if (min === max) continue;
    lastOf[j.id] = played.filter((r) => (r.byJ[j.id] || 0) === min).map((r) => r.key);
    for (const k of lastOf[j.id]) extraX2[k] = (extraX2[k] || 0) + 1;
  }

  const doneJ = jornadas.filter((j) => j.matches.some((m) => m.result));
  const lastJ = doneJ[doneJ.length - 1];
  // Desempate a puntos:
  //   · entre 2 jugadores: 1º quien haya ganado más retos entre ellos, 2º más resultados exactos
  //   · entre 3 o más: más resultados exactos
  const h2h = (x, y) => retoOut.filter((o) => o.winner === x.name && o.loser === y.name).length;
  const cmp = (a, b, f) => f(b) - f(a) || b.exact - a.exact || a.name.localeCompare(b.name);
  const rankBy = (f) => {
    const sorted = [...table].sort((a, b) => f(b) - f(a));
    const out = [];
    for (let i = 0; i < sorted.length; ) {
      let k = i; while (k < sorted.length && f(sorted[k]) === f(sorted[i])) k++;
      const grp = sorted.slice(i, k);
      if (grp.length === 2) grp.sort((a, b) => (h2h(b, a) - h2h(a, b)) || b.exact - a.exact || a.name.localeCompare(b.name));
      else grp.sort((a, b) => b.exact - a.exact || a.name.localeCompare(b.name));
      out.push(...grp); i = k;
    }
    return out;
  };
  const ranked = rankBy((r) => r.pts);
  table.length = 0; table.push(...ranked);
  table.forEach((r, i) => (r.pos = i + 1));
  if (lastJ) {
    rankBy((r) => r.pts - (r.byJ[lastJ.id] || 0)).forEach((r, i) => (byKey[r.key].prevPos = i + 1));
  }

  // Clasificación del mes de la tortilla
  const played = jornadas.flatMap((j) => live(j).filter((m) => m.result).map((m) => Date.parse(m.kickoff)));
  const curP = periodOf(now);
  const pids = new Set(played.map((t) => periodOf(t).id)); pids.add(curP.id);
  const tortilla = { current: curP.id, periods: [...pids].sort().map((pid) => {
    const [y, mm] = pid.split("-").map(Number); const info = periodInfo(y, mm - 1);
    const rows = table.map((r) => ({ name: r.name, pts: (r.tm || {})[pid] || 0, photo: photo[r.name] }))
      .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
    let losers = [];
    if (rows.length >= 3) { const asc = rows.map((r) => r.pts).sort((a, b) => a - b); const th = asc[1]; losers = rows.filter((r) => r.pts <= th).map((r) => r.name); }
    return { ...info, closed: now > info.to, rows, losers };
  }) };

  const curId = currentJornadaId(jornadas, now);
  const outJ = jornadas.map((j) => ({
    id: j.id, num: j.num, title: j.title || "", extra: !!j.extra, current: j.id === curId,
    myPleno: ((byKey[myKey] || {}).plenos || {})[j.id] || 0,
    lastBonus: (lastOf[j.id] || []).includes(myKey),
    winners: jWinners[j.id] || [], winPts: jTop[j.id] || 0,
    retoDeadline: j.matches.length ? retoDeadline(j) : null,
    matches: j.matches.map((m) => {
      const locked = isLocked(m, now);
      // Los pronósticos de los demás solo se ven cuando el partido ha empezado
      const started = !m.cancelled && (!!m.result || (!!m.kickoff && Date.parse(m.kickoff) <= now));
      const others = {};
      const ec = exactCountOf(m, users, preds);
      if (started) {
        for (const u of users) {
          const p = (preds[u.key] || {})[m.id];
          if (p && !m.cancelled) { const sc = scoreFor(p, m, ec, j.extra); others[u.name] = { h: p.h, a: p.a, pts: sc ? sc.pts : null, unique: sc ? sc.unique : false, gold: !!(sc && sc.comodin) }; }
        }
      }
      const myP = (preds[myKey] || {})[m.id] || null;
      const mySc = m.cancelled ? null : scoreFor(myP, m, ec, j.extra);
      const ko = m.kickoff ? Date.parse(m.kickoff) : null;
      return {
        id: m.id, home: m.home, away: m.away, kickoff: m.kickoff || null, result: m.cancelled ? null : m.result || null, tbc: !!m.tbc,
        cancelled: !!m.cancelled, movedFrom: m.movedFrom || null,
        locked, started, status: matchStatus(j, m, now, curId),
        opensAt: ko && ko - OPEN_BEFORE, closesAt: ko && ko - CLOSE_BEFORE,
        mine: myP, myScore: mySc, golden: goldenOf(m), others,
        count: users.filter((u) => (preds[u.key] || {})[m.id]).length,
      };
    }),
  }));

  return {
    me: { name: displayOf(me), username: me.username, email: me.email, admin: !!me.admin, photo: photo[displayOf(me)], profileDone: !!me.display,
      comodines: { total: COMODINES + (extraX2[myKey] || 0) + (me.bonusX2 || 0), extra: (extraX2[myKey] || 0) + (me.bonusX2 || 0), used: Object.entries(preds[myKey] || {}).filter(([mid, p]) => p && p.x2 && !cancelledIds.has(mid)).length },
      retos: { total: RETOS, max: RETOS_MISMO, used: retos.filter((r) => r.from === myKey).length,
        porRival: retos.filter((r) => r.from === myKey).reduce((o, r) => ((o[nameOf[r.to]] = (o[nameOf[r.to]] || 0) + 1), o), {}) } },
    // Antes de empezar la jornada solo ves tus retos; en cuanto empieza, se ven todos
    retos: retoOut.filter((r) => r.started || r.from === displayOf(me) || r.to === displayOf(me)),
    // jugadores que ya tienen reto en cada jornada (retando o retados), sin decir con quién
    retados: Object.fromEntries(jornadas.map((j) => [j.id, [...new Set(retos.filter((r) => r.jornada === j.id).flatMap((r) => [nameOf[r.from], nameOf[r.to]]))]])),
    now,
    jornadas: outJ,
    // los retos y comodines de cada uno son secretos: no se envían los de los demás
    table: table.map(({ key, retoPts, ...r }) => ({ ...r, photo: photo[r.name] })),
    users: users.map((u) => ({ name: u.name, admin: u.admin, photo: photo[u.name], ...(me.admin ? { username: u.username, bonusX2: u.bonusX2 } : {}) })),
    anuncio: data.anuncio || null,
    tortilla,
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

// ---------- Código de invitación de la liga ----------
function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I para no confundir
  let c = ""; for (let i = 0; i < 6; i++) c += A[crypto.randomInt(0, A.length)];
  return c;
}
// Código fijo y fácil por defecto: 112233 (el admin puede cambiarlo o poner uno propio)
const DEFAULT_CODE = "112233";
async function leagueCode(regen, custom) {
  if (custom) { await redis(["SET", P + "code2", custom]); return custom; }
  let c = regen ? null : await redis(["GET", P + "code2"]);
  if (regen) { c = newCode(); await redis(["SET", P + "code2", c]); }
  return c || DEFAULT_CODE;
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
async function tortillaNotify(all) {
  if (!all.users.length) return 0;
  const anyone = await getUser(all.users[0].key); if (!anyone) return 0;
  const st = buildState(anyone, all), now = Date.now(); let sent = 0;
  for (const p of st.tortilla.periods) {
    if (!p.closed || now - p.to > 3 * 864e5 || !p.losers.length) continue;
    const ok = await redis(["SET", P + "tortilla:notified:" + p.id, "1", "NX", "EX", "864000"]);
    if (!ok) continue;
    const dia = new Date(p.friday).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Madrid" });
    const lista = p.losers.join(", ").replace(/, ([^,]*)$/, " y $1");
    for (const u of all.users) sent += await sendPush(u.key, { title: "🥘 ¡Cierre del mes de la tortilla!", body: `${lista} ${p.losers.length > 1 ? "traen" : "trae"} tortilla el ${dia}. ¡Que aproveche!`, tag: "tortilla-" + p.id, url: "./#tortilla" }).catch(() => 0);
  }
  return sent;
}
async function runReminders() {
  const now = Date.now();
  const all0 = await loadAll();
  let sent0 = await tortillaNotify(all0).catch(() => 0);
  const { jornadas, preds, users } = all0;
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
  return sent + sent0;
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
    const count = await redis(["SCARD", P + "users"]);
    // Para entrar en la liga hace falta el código de invitación (el primero, el admin, no)
    if (count) {
      const code = await leagueCode();
      if (String(body.code || "").trim().toUpperCase() !== code) bad("Código de liga incorrecto. Pídeselo al administrador.");
    }
    const salt = crypto.randomBytes(12).toString("hex");
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

  // Retar a otro jugador en la jornada en juego
  if (a === "reto" || a === "cancelReto") {
    const { jornadas, users, retos } = await loadAll();
    const now = Date.now();
    const j = jornadas.find((x) => x.id === body.jornada);
    if (!j) bad("Jornada no encontrada");
    if (j.extra) bad("En las jornadas extra no hay retos");
    if (j.id !== currentJornadaId(jornadas, now)) bad("Solo puedes retar en la jornada que está abierta");
    if (j.matches.some((m) => m.tbc)) bad("Aún faltan horarios por confirmar en esta jornada");
    if (now >= retoDeadline(j)) bad("Ya no se puede: la jornada ha empezado");
    const myK = keyName(me.username);
    let list = retos.slice();
    if (a === "cancelReto") {
      bad("Un reto lanzado no se puede cancelar");
    } else {
      const target = users.find((u) => u.name.toLowerCase() === normName(body.to).toLowerCase());
      if (!target) bad("Jugador no encontrado");
      if (target.key === myK) bad("No puedes retarte a ti mismo");
      // Un solo reto por jornada y jugador: si retas no te pueden retar, y si te retan no puedes retar
      const busy = (k) => list.some((r) => r.jornada === j.id && (r.from === k || r.to === k));
      if (list.some((r) => r.jornada === j.id && r.to === myK)) bad("Ya te han retado en esta jornada: solo puedes tener un reto por jornada");
      if (busy(myK)) bad("Ya tienes un reto en esta jornada");
      if (busy(target.key)) bad(`${target.name} ya tiene un reto esta jornada. Reta a otro`);
      if (list.filter((r) => r.from === myK).length >= RETOS) bad(`Ya has usado tus ${RETOS} retos de la temporada`);
      if (list.filter((r) => r.from === myK && r.to === target.key).length >= RETOS_MISMO) bad(`Ya has retado ${RETOS_MISMO} veces a ${target.name}`);
      list.push({ id: crypto.randomBytes(4).toString("hex"), jornada: j.id, from: myK, to: target.key, at: now });
      // aviso al retado
      sendPush(target.key, { title: "⚔️ ¡TE HAN DESAFIADO!", body: `${displayOf(me)} te reta a muerte en la jornada ${j.num}. El que gane se lo lleva todo. Abre La Porra y prepara tu escudo 🛡️`, tag: "reto-" + j.id, url: "./#jornada" }).catch(() => {});
    }
    await setJSON(P + "retos", list);
    return buildState(me, await loadAll());
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
      if (p.x2 && goldenOf(m)) bad(`No puedes usar el comodín en el ${goldenOf(m)}: ya vale doble`);
      mine[m.id] = { h: goals(p.h), a: goals(p.a), at: now, ...(p.x2 ? { x2: true } : {}) };
      saved++;
    }
    // Comodín: también se puede quitar de un partido abierto sin cambiar el marcador
    for (const m of j.matches) {
      const p = body.picks && body.picks[m.id];
      if (p && p.x2 === false && mine[m.id] && matchStatus(j, m, now, curId) === "open") delete mine[m.id].x2;
    }
    // Máximo un comodín por jornada
    if (live(j).filter((m) => mine[m.id] && mine[m.id].x2).length > 1) bad("Solo puedes usar un comodín x2 por jornada");
    const allData = await loadAll();
    const myTotal = buildState(me, allData).me.comodines.total;
    const cancelledNow = new Set(jornadas.flatMap((jj) => jj.matches.filter((m) => m.cancelled).map((m) => m.id)));
    if (Object.entries(mine).filter(([mid, x]) => x && x.x2 && !cancelledNow.has(mid)).length > myTotal) bad(`Solo tienes ${myTotal} comodines`);
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
    const isExtra = !!body.extra;
    let num = Number(body.num);
    if (isExtra) {
      if (!normName(body.title)) bad("Ponle nombre a la jornada extra (ej. Final de Champions)");
      const ex = body.id && jornadas.find((x) => x.id === body.id);
      num = ex && ex.extra ? ex.num : 1000 + jornadas.filter((x) => x.extra).length + 1;
    } else if (!Number.isInteger(num) || num < 1 || num > 60) bad("Número de jornada no válido");
    const matches = cleanMatches(body.matches);
    let j = body.id ? jornadas.find((x) => x.id === body.id) : null;
    if (jornadas.some((x) => x.num === num && (!j || x.id !== j.id))) bad("Ya existe la jornada " + num);
    if (j) {
      const old = Object.fromEntries(j.matches.map((m) => [m.id, m]));
      j.num = num; j.title = normName(body.title).slice(0, 40); j.extra = isExtra;
      j.matches = matches.map((m) => {
        const o = old[m.id];
        const out = o && o.result && !m.result ? { ...m, result: o.result } : { ...m };
        // si el admin cambia la hora, queda confirmada y el calendario automático ya no la toca
        if (o && o.kickoff === m.kickoff) { out.tbc = !!o.tbc; out.manual = !!o.manual; }
        else out.manual = true;
        return out;
      });
    } else {
      j = { id: crypto.randomBytes(5).toString("hex"), num, extra: isExtra, title: normName(body.title).slice(0, 40), matches: matches.map((m) => ({ ...m, manual: true })) };
      jornadas.push(j);
    }
    regroup(jornadas);
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

  if (a === "code") {
    let custom = null;
    if (body.custom != null) {
      custom = String(body.custom).trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(custom)) bad("El código debe tener entre 4 y 12 letras o números");
    }
    return { code: await leagueCode(!!body.regen, custom) };
  }

  // Aviso a todos: notificación al móvil + mensaje dentro de la app
  if (a === "broadcast") {
    const title = normName(body.title).slice(0, 60) || "📢 La Porra";
    const text = String(body.body || "").trim().slice(0, 300);
    if (!text) bad("Escribe el mensaje");
    const an = { id: crypto.randomBytes(4).toString("hex"), title, body: text, at: Date.now() };
    await setJSON(P + "anuncio", an);
    const { users } = await loadAll();
    let sent = 0;
    for (const u of users) sent += await sendPush(u.key, { title, body: text, tag: "anuncio-" + an.id, url: "./" }).catch(() => 0);
    return { sent, ...buildState(me, await loadAll()) };
  }
  if (a === "clearAnuncio") { await redis(["DEL", P + "anuncio"]); return buildState(me, await loadAll()); }
  // Regalar (o quitar) comodines a un jugador
  if (a === "giveX2") {
    const u = await findByDisplay(body.name);
    if (!u) bad("Usuario no encontrado");
    u.bonusX2 = Math.max(0, (u.bonusX2 || 0) + (Number(body.n) || 1));
    await setJSON(P + "user:" + keyName(u.username), u);
    if ((Number(body.n) || 1) > 0) sendPush(keyName(u.username), { title: "🎁 ¡Comodín extra!", body: "El administrador te ha regalado un comodín x2. ¡Úsalo bien!", tag: "regalo", url: "./" }).catch(() => {});
    return buildState(me, await loadAll());
  }

  if (a === "resetRetos") { await redis(["DEL", P + "retos"]); return buildState(me, await loadAll()); }

  if (a === "syncCalendar") { await syncCalendar(true); return buildState(me, await loadAll()); }

  if (a === "deleteJornada") {
    const i = jornadas.findIndex((x) => x.id === body.id);
    if (i < 0) bad("Jornada no encontrada");
    jornadas.splice(i, 1);
    await setJSON(P + "jornadas", jornadas);
    return buildState(me, await loadAll());
  }

  if (a === "setCancelled") {
    const j = jornadas.find((x) => x.id === body.jornada);
    const m = j && j.matches.find((x) => x.id === body.match);
    if (!m) bad("Partido no encontrado");
    if (body.cancelled) { m.cancelled = true; delete m.result; } else delete m.cancelled;
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
module.exports._test = { periodOf, periodInfo, cutMs, regroup, handle, setRedis: (f) => (redisImpl = f), points, runReminders };
