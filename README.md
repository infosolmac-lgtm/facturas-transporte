# Facturas de Transporte

Aplicación web para controlar las facturas recibidas de empresas de transporte y logística: qué facturas hay, cuáles están pendientes, vencidas o pagadas, cuánto se debe y cuánto se gasta con cada empresa. Cada factura puede llevar asociado su PDF o fotografía.

Es una herramienta de control de pagos, **no un sistema contable**. No se conecta a bancos: los pagos se registran manualmente.

- **Aplicación:** https://infosolmac-lgtm.github.io/facturas-transporte/
- **Versión:** ver `config.js` (también aparece en *Configuración* dentro de la app)

---

## 1. Funcionalidades

| Sección | Contenido |
|---|---|
| **Inicio** | Nº de facturas vencidas, pendientes y pagadas; importe pendiente, vencido, pagado y facturado del mes; avisos de facturas que vencen en los próximos 7 días; listas de vencidas y próximos vencimientos. |
| **Facturas** | Listado con búsqueda (nº, concepto, empresa) y filtros (empresa, estado, año, mes, rango de vencimiento, importe). Ordenable por columna. |
| **Detalle de factura** | Todos los datos, documento adjunto (ver / descargar / reemplazar), historial de cambios con usuario y fecha. Acciones: marcar como pagada, pago parcial, editar, anular, deshacer pago, reactivar. |
| **Nueva factura** | Formulario con vista previa del PDF o foto al lado. Atajos de vencimiento (+15, +30, +60 días) y cálculo de IVA 21 %. |
| **Empresas** | Alta, edición y ficha de cada empresa con sus totales, próximos vencimientos y facturas. |
| **Informes** | Gasto por empresa, mensual y anual. Impresión en A4 / PDF. |
| **Configuración** | Datos del usuario, cambio de contraseña, usuarios con acceso, cerrar sesión. |

### Reglas automáticas

- **Vencida** no se guarda: se calcula al consultar. Una factura pendiente o con pago parcial cuya fecha de vencimiento es anterior a hoy (hora de Madrid) aparece como vencida.
- Al marcar como pagada se registran automáticamente la fecha de pago, el importe pagado y **quién** la marcó.
- Quién crea y quién modifica cada factura lo registra la base de datos, no el navegador.
- Las facturas **no se borran**: se anulan. Una factura anulada no cuenta en importes ni informes y puede reactivarse.
- Todo cambio queda en el historial de la factura (tabla `invoice_events`), que no se puede modificar desde la app.
- No puede haber dos facturas con el mismo número para la misma empresa.

---

## 2. Tecnología y coste

| Servicio | Uso | Plan |
|---|---|---|
| **GitHub Pages** | Aloja la aplicación (HTML, CSS y JavaScript sin compilación). | Gratuito (repositorio público) |
| **Supabase** | Base de datos PostgreSQL, usuarios (Auth) y almacenamiento de documentos (Storage). | Gratuito |

**Coste actual: 0 €.**

### Archivos del repositorio

| Archivo | Contenido |
|---|---|
| `index.html` | Página única de la aplicación. |
| `style.css` | Estilos (ordenador, móvil e impresión A4). |
| `app.js` | Toda la lógica de la aplicación. |
| `config.js` | URL y clave pública de Supabase, días de aviso y versión. |
| `001_esquema_inicial.sql` | Script que crea la base de datos completa en Supabase. |
| `README.md` | Este documento. |

### Seguridad

- Solo pueden entrar usuarios dados de alta manualmente en Supabase. El registro público está desactivado.
- Todas las tablas tienen **Row Level Security**: sin sesión iniciada no se puede leer ni escribir nada.
- Los documentos están en un bucket **privado**. Se abren mediante enlaces temporales de 5 minutos.
- La clave que aparece en `config.js` (`sb_publishable_...`) es **pública por diseño**. La protección la da el login + RLS.

**Nunca subir a GitHub:**
- La contraseña de la base de datos.
- La clave secreta de Supabase (`sb_secret_...` o `service_role`).
- Contraseñas de usuarios.

---

## 3. Instalación desde cero

Sirve para montar la aplicación en una cuenta nueva (por ejemplo, la de la empresa).

### 3.1 Supabase

1. Crear cuenta en https://supabase.com.
2. Crear una organización (plan Free) y dentro un proyecto:
   - Región: **West EU (Ireland)**.
   - **Enable Data API:** activado.
   - **Automatically expose new tables:** desactivado.
   - **Enable automatic RLS:** activado.
   - Guardar la contraseña de la base de datos en un lugar seguro (no en GitHub).
3. **SQL Editor → New query**: pegar el contenido completo de `001_esquema_inicial.sql` y pulsar **Run**. Resultado esperado: `Success. No rows returned`. Ejecutarlo **una sola vez**.
4. **Authentication → Sign In / Providers**:
   - *Allow new users to sign up*: **desactivado**.
   - *Allow anonymous sign-ins*: **desactivado**.
   - *Email*: **Enabled**.
   - Pulsar **Save changes**.
5. **Authentication → URL Configuration → Site URL**: poner la dirección de la aplicación (ej. `https://CUENTA.github.io/facturas-transporte/`) y guardar. Necesario para que los enlaces de recuperación de contraseña lleven a la app.
6. **Project Settings → API Keys**: copiar la **Project URL** y la **Publishable key**.

### 3.2 GitHub

1. Crear un repositorio **público** y subir todos los archivos.
2. Editar `config.js` con la URL y la publishable key del nuevo proyecto:
   ```js
   SUPABASE_URL: 'https://XXXXXXXX.supabase.co',
   SUPABASE_KEY: 'sb_publishable_XXXXXXXX',
   ```
3. **Settings → Pages → Branch:** `main` y `/ (root)` → **Save**.
4. A los 1–2 minutos la dirección aparece en esa misma página.

### 3.3 Usuarios

Ver apartado 4.

---

## 4. Gestión de usuarios

### Dar de alta

1. Supabase → **Authentication → Users → Add user → Create new user**.
2. Email y contraseña provisional. Dejar marcado **Auto Confirm User**.
3. **SQL Editor**, asignar nombre y rol (`admin` o `user`):
   ```sql
   update public.profiles
      set full_name = 'Nombre', role = 'user'
    where email = 'correo@empresa.com';
   ```
4. El usuario puede cambiar su contraseña en **Configuración** dentro de la app.

### Dar de baja (sin perder el historial)

```sql
update public.profiles set active = false where email = 'correo@empresa.com';
```

Un usuario inactivo no puede entrar, pero su nombre sigue apareciendo en las facturas que registró o pagó. Para reactivarlo: `active = true`.

### Ver usuarios

```sql
select full_name, email, role, active from public.profiles order by full_name;
```

### Contraseña olvidada

Supabase → **Authentication → Users** → seleccionar el usuario → **Send password recovery**. El usuario recibe un correo; al pulsar el enlace entra en la app y cambia la contraseña en **Configuración**. Requiere tener configurada la *Site URL* (apartado 3.1, paso 5).

---

## 5. Traspaso a la empresa

La aplicación está en cuentas separadas para poder transferirse completa sin rehacer nada.

### Repositorio GitHub

1. **Settings → General →** al final, **Danger Zone → Transfer ownership**.
2. Indicar la cuenta u organización de destino.
3. La dirección de GitHub Pages cambiará a `https://CUENTA-NUEVA.github.io/facturas-transporte/`. Avisar a los usuarios.

### Supabase

1. En la organización `facturas-transporte`, **Team**: invitar a la persona de la empresa con rol **Owner**.
2. Cuando acepte, el propietario anterior puede salir de la organización o quedar con rol **Developer** o **Read-only**.
3. La URL y la clave del proyecto **no cambian**, por lo que `config.js` no necesita modificarse.

Nota: el límite de 2 proyectos gratuitos se aplica a cada persona en todas las organizaciones donde es **Owner** o **Administrator**. Tras el traspaso, el proyecto deja de contar en la cuota del propietario anterior si este sale o pasa a otro rol.

---

## 6. Límites del plan gratuito de Supabase

| Recurso | Límite | Referencia práctica |
|---|---|---|
| Base de datos | 500 MB | Suficiente para cientos de miles de facturas. |
| Almacenamiento de documentos | 1 GB | Un PDF de factura ocupa ~100–300 KB: varios miles de documentos. Máx. 10 MB por archivo. |
| Proyectos activos | 2 por persona | Ver apartado 5. |
| **Pausa por inactividad** | 7 días sin uso | Si nadie usa la app durante una semana, Supabase pausa el proyecto. **No se pierden datos.** Para reactivarlo: entrar en supabase.com → proyecto → **Restore project**. |

Si el uso crece o la pausa resulta un problema, el plan **Pro** de Supabase elimina la pausa. Comprobar el precio vigente en https://supabase.com/pricing antes de contratar.

---

## 7. Mantenimiento

### Actualizar la aplicación

1. Repositorio → **Add file → Upload files** → arrastrar los archivos modificados → **Commit changes**.
2. Subir el número de `VERSION` en `config.js` en cada cambio.
3. GitHub Pages publica en 1–2 minutos. En el móvil, cerrar y volver a abrir la pestaña para cargar la versión nueva.

### Copia de seguridad manual

El plan gratuito no incluye copias automáticas descargables. Para exportar:
- **Table Editor** → tabla `invoices` (o `transport_companies`) → **Export → CSV**.
- Los documentos se descargan desde **Storage → facturas**.

### Añadir una empresa de transporte

Desde la propia app: **Empresas → + Nueva empresa**.

---

## 8. Pendiente / próximas fases

- Lectura automática de datos desde el PDF (OCR / IA), con revisión humana antes de guardar.
- Avisos por email a 7, 3 y 1 día del vencimiento.

## 9. Fuera de alcance

Conexión bancaria, contabilidad, conciliación, emisión de facturas, ERP, gestión de clientes, nóminas, inventarios, WhatsApp, aplicación móvil nativa.
