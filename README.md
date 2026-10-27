# Estructural MSMIN · app de celular

App instalable (PWA) con las mismas apps del portal. Se publica como página estática (por ejemplo GitHub Pages) y habla directo con Supabase (`apps-mantenimiento`).

## Archivos
- `index.html`: la app completa (acceso, apps, visor, ajustes, equipo).
- `manifest.webmanifest`, `sw.js`, `icons/`: lo que permite instalarla y abrirla sin señal.

## Acceso del equipo
- Tabla `portal_usuarios` (email, nombre, rol `admin`/`usuario`, activo, código).
- El administrador agrega personas desde Ajustes > Equipo; la app genera un código de invitación.
- La persona toca "Activar cuenta", ingresa correo + código y elige su contraseña. No se envían correos.
- La activación la hace la función Edge `portal-activar` (anula el código al usarse; 5 intentos fallidos lo anulan).
- Olvido de contraseña: el administrador genera un código nuevo y la persona vuelve a "Activar cuenta".

## Permisos (RLS)
- `portal_apps`: el equipo lee; solo administradores agregan, editan o quitan.
- `portal_usuarios`: cada persona ve su fila; solo administradores gestionan.
- Solo valen cuentas creadas por la app (`app_metadata.portal = true`).
- El portal en Apps Script sigue funcionando igual (usa la clave de servicio).

La clave que aparece en `index.html` es la clave publicable de Supabase: es pública por diseño.
