# ⚽ La Porra · Madrid · Barça · Depor · Celta

Porra online para pronosticar cada jornada de Primera los partidos del Real Madrid, FC Barcelona, Deportivo y Celta. Se instala como app en iPhone y Android.

## Reglas
- **3 puntos** resultado exacto · **1 punto** acertar el signo 1X2 · **0** si fallas el signo.
- Cada partido se abre **7 días antes** y se cierra **1 minuto antes** de empezar.
- Solo se puede pronosticar **la jornada siguiente**.
- Los pronósticos del resto están **ocultos hasta que empieza el partido**.
- **Aviso al móvil 1 hora antes** si te falta un pronóstico.
- Clasificación acumulada; empate a puntos → más resultados exactos.

## Cómo funciona
- `index.html` — la app (una sola página).
- `api/porra.js` — servidor (Vercel) con base de datos Upstash Redis.
- `sw.js` + `manifest.json` + `icons/` — app instalable y notificaciones.
- `.github/workflows/avisos.yml` — cada 10 min lanza los avisos.

El **primer usuario que se registra es el administrador**: crea las jornadas, mete los resultados y gestiona jugadores.

## Puesta en marcha (Vercel)
1. En Vercel: **Add New → Project** e importa este repositorio.
2. En el proyecto: **Storage → Upstash (Redis) → Connect**. Crea las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
3. (Opcional, para recuperar contraseña por correo) en **Settings → Environment Variables**:
   - `GMAIL_USER` = tu Gmail
   - `GMAIL_APP_PASSWORD` = una contraseña de aplicación de Google (myaccount.google.com → Seguridad → Contraseñas de aplicaciones)
4. Redeploy.
5. En GitHub: **Settings → Secrets and variables → Actions → Variables** crea `SITE_URL` con la dirección de la web (p. ej. `https://la-porra.vercel.app`) para que salgan los avisos.

## Instalar en el móvil
- **iPhone:** Safari → Compartir → *Añadir a pantalla de inicio*. Ábrela desde el icono y activa los avisos en tu perfil (iOS 16.4 o superior).
- **Android:** Chrome → menú ⋮ → *Instalar aplicación*.
