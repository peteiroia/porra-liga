# ⚽ La Porra · Madrid · Barça · Depor · Celta

Porra online para pronosticar cada jornada de Primera los partidos del Real Madrid, FC Barcelona, Deportivo y Celta. Se instala como app en iPhone y Android.

## Reglas
- **3 puntos** resultado exacto · **1 punto** acertar el signo 1X2 · **0** si fallas el signo.
- Cada partido se abre **7 días antes** y se cierra **1 minuto antes** de empezar.
- Solo se puede pronosticar **la jornada siguiente**.
- Los pronósticos del resto están **ocultos hasta que empieza el partido**.
- **Aviso al móvil 1 hora antes** si te falta un pronóstico.
- Cuenta el resultado a los 90 minutos (sin prórroga ni penaltis).
- 🔴 Resultados en directo: mientras hay partido, el servidor consulta el marcador público de ESPN (como mucho cada 40 s) y la app muestra marcador y minuto. Al acabar se guarda solo el resultado a los 90 minutos; el administrador puede corregirlo.
- Partido aplazado → anulado: no puntúa y se devuelve el comodín. En `data/calendario.json` se marca con `"postponed": true`.
- Si un partido cambia de fecha, pasa solo a la jornada más cercana a su nueva fecha.
- Jornadas extra (selecciones, Champions, Copa…): partido suelto que suma a la general; se admite comodín, sin retos ni bonus.
- Clasificación acumulada. Empate entre 2 → más retos ganados entre ellos, luego más exactos. Empate entre 3 o más → más exactos.
- 🍳 **Mes de la tortilla**: clasificación mensual con corte el último miércoles de cada mes (23:59). Los tres últimos (y los empatados con el antepenúltimo o por debajo) se las apañan entre ellos para traer una tortilla el viernes siguiente. Castelao es Pablo Gómez: si pierde, paga Pablo Gómez.
- 🏆 **Gana quien tenga más puntos al acabar la jornada 38 de la Liga 2026-2027.**

## Cómo funciona
- `index.html` — la app (una sola página).
- `api/porra.js` — servidor (Vercel) con base de datos Upstash Redis.
- `sw.js` + `manifest.json` + `icons/` — app instalable y notificaciones.
- `.github/workflows/avisos.yml` — cada 10 min lanza los avisos.
- `data/calendario.json` — calendario oficial 2026-27 de Madrid, Barça, Depor y Celta (jornadas 11-38). Se carga solo en la app; al cambiar su `version` se actualizan horas y resultados. Los partidos con `tbc: true` tienen la hora por confirmar y no se abren hasta que se confirme.

El **primer usuario que se registra es el administrador**: crea las jornadas, mete los resultados y gestiona jugadores.

## Puesta en marcha (Vercel)
1. En Vercel: **Add New → Project** e importa este repositorio.
2. En el proyecto: **Storage → Upstash (Redis) → Connect**. Crea las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
3. (Ya no hace falta: si alguien olvida la contraseña, el administrador le pone una nueva desde Admin → Jugadores → 🔑) en **Settings → Environment Variables**:
   - `GMAIL_USER` = tu Gmail
   - `GMAIL_APP_PASSWORD` = una contraseña de aplicación de Google (myaccount.google.com → Seguridad → Contraseñas de aplicaciones)
4. Redeploy.
5. En GitHub: **Settings → Secrets and variables → Actions → Variables** crea `SITE_URL` con la dirección de la web (p. ej. `https://porra-liga.vercel.app`) para que salgan los avisos.

## Instalar en el móvil
- **iPhone:** Safari → Compartir → *Añadir a pantalla de inicio*. Ábrela desde el icono y activa los avisos en tu perfil (iOS 16.4 o superior).
- **Android:** Chrome → menú ⋮ → *Instalar aplicación*.
