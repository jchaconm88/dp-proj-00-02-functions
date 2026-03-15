# Cloud Functions para Firebase — layout-admin

Proyecto de **Firebase Cloud Functions** que expone una API de autenticación usando Firebase Auth (Identity Toolkit). Incluye un endpoint `/login` para obtener un token válido a partir de email y contraseña.

---

## Requisitos previos

- **Node.js** 20 (recomendado LTS)
- **Firebase CLI**: `npm install -g firebase-tools`
- Cuenta de Firebase y proyecto **layout-admin** ya creado en [Firebase Console](https://console.firebase.google.com/)
- **Web API Key** del proyecto (Configuración del proyecto → General → Claves de API)

---

## Estructura del proyecto

```
dp-proj-00-02-functions/
├── .firebaserc          # Proyecto por defecto: layout-admin
├── .github/
│   └── workflows/
│       └── deploy-firebase-functions.yml   # CI: deploy en push a main
├── firebase.json        # Configuración: source de functions
├── .gitignore
├── README.md
└── functions/
    ├── package.json
    └── index.js         # Express app + export authFunction
```

- **authFunction**: función HTTP que monta la app Express.
- **Rutas**: `GET /` (health), `POST /login` (autenticación).

---

## Instalación

1. **Clonar o abrir el repositorio** y entrar en la raíz del proyecto.

2. **Instalar dependencias** de las functions:

   ```bash
   cd functions
   npm install
   cd ..
   ```

3. **Iniciar sesión en Firebase** (si aún no lo has hecho):

   ```bash
   firebase login
   ```

4. **Configurar el secreto de la API Key** (obligatorio antes del primer deploy):

   ```bash
   firebase functions:secrets:set APP_FIREBASE_API_KEY
   ```

   Cuando lo pida, pega la **Web API Key** de tu proyecto Firebase (Configuración del proyecto → General → Claves de API). El valor se guarda en **Secret Manager** y no se expone en código ni en logs.

---

## Configuración

| Elemento | Dónde |
|----------|--------|
| Proyecto Firebase | `.firebaserc` → `default: "layout-admin"` |
| Origen del código | `firebase.json` → `functions.source: "functions"` |
| API Key | Secreto `APP_FIREBASE_API_KEY` en Secret Manager |

Para usar otro proyecto:

```bash
firebase use <project-id>
```

---

## Scripts disponibles

Desde la **raíz del proyecto**:

| Comando | Descripción |
|--------|-------------|
| `firebase deploy --only functions` | Despliega todas las functions |
| `firebase emulators:start --only functions` | Inicia el emulador de functions en local |
| `firebase functions:log` | Muestra logs de las functions en producción |

Desde la carpeta **functions** (según `package.json`):

| Comando | Descripción |
|--------|-------------|
| `npm run serve` | Emulador: `firebase emulators:start --only functions` |
| `npm run deploy` | Deploy: `firebase deploy --only functions` |
| `npm run logs` | Logs: `firebase functions:log` |
| `npm run shell` | Shell interactivo de functions |

---

## API

Base URL tras el deploy:

```
https://<region>-layout-admin.cloudfunctions.net/authFunction
```

Por defecto la región suele ser `us-central1`.

### Health

- **GET** `/authFunction/`  
  Respuesta: `{ "status": "ok", "service": "authFunction" }`.

### Login

- **POST** `/authFunction/login`
- **Body (JSON):** `{ "email": "string", "password": "string" }`
- **Headers:** `Content-Type: application/json`

**Respuesta correcta (200):**

```json
{
  "idToken": "...",
  "refreshToken": "...",
  "expiresIn": "3600",
  "localId": "...",
  "email": "usuario@ejemplo.com"
}
```

**Errores:**

- **400**: Faltan `email` o `password`.
- **401** (u otro 4xx de Identity Toolkit): Credenciales inválidas o usuario deshabilitado; el body incluye el mensaje de Firebase.
- **500**: Error interno (red, timeout, etc.).

#### Ejemplo con cURL

```bash
curl -X POST "https://us-central1-layout-admin.cloudfunctions.net/authFunction/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"tu@email.com\",\"password\":\"tupassword\"}"
```

#### Ejemplo con fetch (JavaScript)

```javascript
const res = await fetch(
  "https://us-central1-layout-admin.cloudfunctions.net/authFunction/login",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tu@email.com", password: "tupassword" }),
  }
);
const data = await res.json();
if (res.ok) {
  console.log("idToken:", data.idToken);
} else {
  console.error("Error:", data.error || data.message);
}
```

---

## CORS

La función está publicada con **CORS habilitado** (`cors: true` en la definición de la función), por lo que puede ser llamada desde el navegador desde cualquier origen.

Para **producción** es recomendable restringir orígenes. En `functions/index.js`, en el objeto `authApiOptions`, puedes usar por ejemplo:

```javascript
cors: ["https://tudominio.com", /\.tudominio\.com$/],
```

y luego volver a desplegar.

---

## Despliegue

1. Asegúrate de tener configurado el secreto:

   ```bash
   firebase functions:secrets:set APP_FIREBASE_API_KEY
   ```

2. Desde la raíz del proyecto:

   ```bash
   firebase deploy --only functions --force
   ```

   (`--force` permite que Firebase configure la política de limpieza de artefactos en la región si es la primera vez.)

3. La consola mostrará la URL de la función, por ejemplo:

   ```
   https://us-central1-layout-admin.cloudfunctions.net/authFunction
   ```

   El endpoint de login es: **`<esa-url>/login`**.

---

## Despliegue con GitHub Actions

El pipeline en `.github/workflows/deploy-firebase-functions.yml` despliega las functions automáticamente al hacer **push a la rama `main`**. También puedes ejecutarlo manualmente en **Actions** → **Deploy Firebase Functions** → **Run workflow**.

La autenticación usa una **cuenta de servicio** y `GOOGLE_APPLICATION_CREDENTIALS` (recomendado por Firebase; el uso de `--token` está deprecado).

### Configuración (una sola vez)

1. **Crear una cuenta de servicio en Google Cloud**:
   - [Google Cloud Console](https://console.cloud.google.com/) → selecciona el proyecto **layout-admin** (o el que uses con Firebase).
   - **IAM y administración** → **Cuentas de servicio** → **Crear cuenta de servicio**.
   - Nombre, por ejemplo: `github-actions-deploy`.
   - **Crear y continuar** → en “Conceder acceso al proyecto”, añade el rol **Editor** (o al menos **Cloud Functions Admin** + **Service Account User**).
   - **Listo** → en la lista, abre la cuenta → pestaña **Claves** → **Añadir clave** → **Crear clave nueva** → **JSON** → descarga el archivo.

2. **Añadir el JSON como secret en GitHub**:
   - Repositorio → **Settings** → **Secrets and variables** → **Actions**
   - **New repository secret**
   - Nombre: `FIREBASE_SERVICE_ACCOUNT`
   - Valor: **todo el contenido** del archivo JSON descargado (copiar/pegar completo).

3. Sube los cambios a `main` o ejecuta el workflow manualmente. El job instalará dependencias en `functions/` y ejecutará `firebase deploy --only functions` usando la cuenta de servicio.

---

## Emulador local

Para probar en local sin desplegar:

```bash
firebase emulators:start --only functions
```

La URL base será algo como `http://127.0.0.1:5001/layout-admin/us-central1/authFunction`.  
**Importante:** en local también necesitas tener el secreto; la primera vez que ejecutes el emulador, Firebase CLI puede pedirte el valor de `APP_FIREBASE_API_KEY` o usar un archivo `.env` en `functions/` (no subas `.env` al repositorio).

---

## Logs

- En producción:

  ```bash
  firebase functions:log
  ```

- Para una función concreta o por severidad, revisa la documentación de `firebase functions:log` o la pestaña **Logs** en Firebase Console → Functions.

---

## Seguridad y buenas prácticas

- La **API Key** no se expone al cliente: solo se usa en el servidor (Cloud Function) vía **Secret Manager** (`defineSecret`).
- No se registra ni se devuelve la API Key en logs ni en respuestas.
- El endpoint de Firebase que se usa es el oficial: **Identity Toolkit** `accounts:signInWithPassword`.
- En producción, restringe **CORS** a tus dominios y usa **HTTPS** (Firebase ya sirve las functions por HTTPS).

---

## Solución de problemas

| Problema | Posible causa | Qué hacer |
|----------|----------------|-----------|
| "Missing or insufficient permissions" al desplegar | Secret no definido | `firebase functions:secrets:set APP_FIREBASE_API_KEY` |
| 401 / INVALID_LOGIN_CREDENTIALS | Email o contraseña incorrectos, o usuario no existe | Revisar credenciales y que el usuario esté creado en Authentication |
| 500 en login | Timeout o error de red con Identity Toolkit | Revisar `firebase functions:log` y que la API Key sea la correcta |
| CORS en navegador | Origen no permitido (si restringiste CORS) | Añadir tu origen a la opción `cors` en `authApiOptions` |

---

## Referencias

- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Identity Toolkit: signInWithPassword](https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithPassword)
- [Cloud Functions (2nd gen) – eventos HTTP](https://firebase.google.com/docs/functions/http-events)
- [Configurar secretos en Functions](https://firebase.google.com/docs/functions/config-env#secret-manager)
