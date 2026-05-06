# Cloud Functions — retirada del despliegue

La arquitectura objetivo concentra la lógica en **`dp-proj-00-02-backend`** (Cloud Run). Este repositorio **no** forma parte del flujo de infraestructura ni de CI de despliegue activo.

- El workflow `deploy-firebase-functions.yml` **no** se ejecuta en `push` a `main`.
- Para invocaciones que antes usaban callables, el plan es exponer equivalentes en el **backend** y actualizar **web** para consumirlos por HTTP (ver `dp-proj-00-02-web/app/lib/functions.service.ts` y usos de `callHttpsFunction`).

Mientras dure la migración, podéis desplegar funciones manualmente con `firebase deploy --only functions` desde una máquina con credenciales, si aún lo necesitáis.
