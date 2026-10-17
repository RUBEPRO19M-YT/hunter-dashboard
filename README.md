# Actualizaciones — Fase 1 (usuarios únicos, bans, rangos, skins, web pública)

## Qué sustituir / añadir en tu repo `hunter-dashboard`

| Archivo aquí | Acción en tu repo |
|---|---|
| `server.js` | **Reemplaza por completo** tu `server.js` actual |
| `package.json` | Reemplaza (solo añade `multer`, revisa si tenías algo más y mantenlo) |
| `views/index.ejs` | **Reemplaza por completo** |
| `views/admin.ejs` | **Reemplaza por completo** |
| `public/skins/` | Carpeta nueva, créala en tu repo (vacía, con `.gitkeep`) |

`views/linked.ejs` **no lo toques** — no lo he modificado, se queda como estaba.

Después de subir todo:
```bash
npm install
npm start
```
(`npm install` es necesario porque se añadió `multer` para la subida de skins).

## Qué se ha implementado

1. **Usuarios únicos**: `registerOrRenameUsername()` comprueba, antes de registrar o
   renombrar a alguien, que el nombre no esté ya cogido por otro aspirante
   (comparación case-insensitive) ni en la lista negra.

2. **Lista de nombres prohibidos**: nueva colección `BannedName` en Mongo,
   gestionable desde `/admin` (añadir/quitar con motivo).

3. **Rename seguro desde admin**: `/admin/rename` cambia el `username` pero
   **nunca toca `discordId`**, que es lo que usa tu launcher como `uuid` al
   lanzar el juego. Mientras el servidor de Minecraft derive el UUID real del
   jugador a partir de ese mismo `discordId` (ver nota de la Fase 2 más abajo,
   el fix server-side de UUID), el inventario no se perderá al renombrar.

4. **Rangos**: campo `rank` en cada aspirante (`aspirante`, `verificado`,
   `hunter`, `admin`), editable desde el panel. Esto es la base para que tu
   futuro mod de Forge (Fase 3) pinte el nametag/tablist con un color o
   prefijo distinto según rango.

5. **Baneos**: `banned` + `banReason`. Un aspirante baneado no pasa
   `/api/verify/:discordId` (así que tu launcher actual, que ya llama a ese
   endpoint, lo bloqueará) y tampoco puede completar el login en la web.

6. **Skins (nivel básico)**: subida de un `.png` desde el dashboard web
   (`POST /api/skin/upload`), guardado como `public/skins/<discordId>.png` y
   servido en `/public/skins/<discordId>.png`. `/api/verify/:discordId` ahora
   devuelve también `skinUrl` para que el launcher o tu mod puedan usarla.
   **Esto NO aplica la skin dentro del juego todavía** — eso requiere un
   servidor de skins compatible con tu modpack offline (lo normal es un mod
   tipo "CustomSkinLoader" apuntando a esta URL). Te lo monto en la Fase
   siguiente si quieres.

7. **Web pública con info del evento**: `views/index.ejs` ahora tiene una
   landing con explicación del evento, visible sin necesidad de login, con
   el botón "Iniciar sesión con Discord" arriba a la derecha. Tras hacer
   login, debajo aparece el panel del aspirante (número, rango, subida de
   skin).

## Lo que falta (próximas fases, son trabajo de mod Java, no de esta web)

- **Fix de UUID en el servidor de Minecraft**: para que el rename no pierda
  inventario de verdad en el juego, el servidor necesita dejar de derivar el
  UUID del nombre (comportamiento offline-mode por defecto) y usar en su
  lugar un UUID fijo basado en el `discordId`. Esto se hace con un mod/mixin
  del lado servidor — lo monto en la siguiente entrega si confirmas que
  seguimos por ahí.
- **Número en nametag + tablist + chapa/badge**, **rangos visibles en
  juego**, **leaderboard**, **bloqueo del cliente**: todo esto es el mod de
  Forge propio (Java) del que hablamos — necesita su propio proyecto (MDK),
  independiente de este dashboard web.
