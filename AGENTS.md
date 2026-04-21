# Guía para el agente (Firebase Functions)

Resumen de convenciones de **`dp-proj-00-02-functions`**. Las reglas detalladas viven en **`.cursor/rules/firebase-functions-conventions.mdc`**.

## Layout

- Las reglas de Firestore viven en **`dp-proj-00-02-web/firestore.rules`**; este repo no las duplica ni las despliega (solo Cloud Functions).
- `functions/index.js` → solo re-exports.
- `functions/src/features/<dominio>/*.function.js` → handlers (HTTP, callable, Firestore, etc.).
- `functions/src/lib/` → utilidades y lógica compartida.

## Lib

- **`firebase.js`**: única inicialización Admin + `db`.
- **`*.service.js`**: dominio reutilizable (`sequence-code.service.js`, `trip-cost.service.js`).
- No usar nombres tipo `*-admin.js` en `lib`.

## Callable de secuencias

- Nombre exportado: **`generateSequenceCode`**. La web (`dp-proj-00-02-web`) debe invocar el mismo nombre vía **`callHttpsFunction`** en **`~/lib/functions.service.ts`** (no usar `httpsCallable` directamente en features).

## Despachadores Firestore (un trigger por colección)

- **`onTripsWrite`** (`trips/{tripId}`): `Promise.all` con handlers internos (flete en `trip-charges`, cascada en borrado). Añadir tareas paralelas solo si no compiten por los mismos docs/triggers.
- **`onTripAssignmentsWrite`** (`trip-assignments/{assignmentId}`): `Promise.all` con handlers (sync → `trip-costs`). Misma regla para paralelismo.

### `trip-assignments` → `trip-costs` y flete en `trip-charges`

- **Estándar de IDs** (documentos creados por sync en Functions): `sync__{tipo}__{idOrigen}`.
  - Cargo de flete: `sync__trip_freight__{tripId}` en `trip-charges`.
  - Costo por asignación: `sync__assignment_cost__{assignmentId}` en `trip-costs`.
- Costos **`source: manual`**: el sync no sobrescribe `code` (solo `tripId` + auditoría).
- **`displayName`**: en `salary_rule` se copia de la asignación; en **`manual`** el sync fuerza `displayName: ""`.

### `settlements/{id}/items`

- **`onSettlementItemsWrite`**: un solo `onDocumentWritten`; en borrado corre en paralelo desenlace en `trip-charges`/`trip-costs` y recálculo de `totals`.

## Tras renombrar archivos

Actualizar todos los `require("../../lib/...")` en features y validar:

```bash
cd functions && node -e "require('./index.js'); console.log('ok');"
```
