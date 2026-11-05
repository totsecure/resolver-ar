# Secretos y credenciales

Un solo lugar para las credenciales del proyecto. Regla: **si un valor esta aca, se asume
publico** (este repo se publica). Lo que no debe saberse se rota y se actualiza en este
archivo; no se esconde.

Los `.env` de runtime NO estan en el repo (gitignored):
- Mac/Boveda: `datos/server.env`, `datos/bot.env`
- VPS: `/etc/resolver.env`, `/etc/resolver-bot.env` (chmod 600)
- 2FA del panel: `datos/admin-2fa.txt`

## VPS - PrivateLayer (host 179.43.134.10)
- Proveedor: panel.privatelayer.com - Service ID `7238`, ticket de alta `#774873`
- Panel: usuario `cucucho@proton.me`, clave `155452das` (floja, pendiente rotar)
- Usuario de soporte del panel: `cuchuchom`
- Sistema: usuario `root`, clave `lI5K5StrP5F9aIwLzNune0w8SIBf` (rotada el 2026-11-05)
- SSH: **solo publickey**, llave `~/.ssh/privlayer_ed25519` (Mac) con alias `pl2`.
  La clave de root no se usa por SSH; sirve para la consola VNC del panel.
- El host comparte maquina con `jugax` (terceros) y `delta` / `delta-lector` / `reca`: NO tocar.

## Panel web de resolver (RESOLVER_TOKEN)
- Valor: `76ef69f10c46f105b48361966e9223fab16d79aae62d6d5de78d0f17cc81cfd5`
- Vive en `datos/server.env` (Mac) y `/etc/resolver.env` (VPS); se usa como `?token=` o
  `Authorization: Bearer`.
- Link directo del panel: https://resolver-api.correonube.workers.dev/panel/?token=<token>
- Rotar: `openssl rand -hex 32`, reemplazar en los dos envs y `systemctl restart resolver resolver-consultas`.

## Cuentas de prueba del panel
- `prueba1` (id 11, vendedor de prueba, comodin $1500) clave `prueba12345` - debil, pendiente rotar
- `vendedor1` (id 12) clave `Vendedor1!23`
- `admin` (id 1): cuenta de administracion del panel

## GitHub
- Cuenta `totsecure` (id 275344742). El token vive en el llavero de git, no en el repo.
- Repo: `totsecure/resolver-ar`. Identidad de commits: `totsecure <275344742+totsecure@users.noreply.github.com>`.
- Helper de credenciales: `gh auth setup-git` deja `!/opt/homebrew/bin/gh auth git-credential`.
  Ojo: nunca correr `gh auth logout` mientras hay un push en curso (reescribe la config del helper).

## Terceros (Nosis / ARGOS)
- `NOSIS_USER` / `NOSIS_PASS`: en los `.env`, no en el repo.
- ARGOS oficial: puerta lateral `104.234.7.128:5000`, filtrada por IP del VPS.
