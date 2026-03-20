# Guía para el agente (Firebase Functions)

Resumen de convenciones de **`dp-proj-00-02-functions`**. Las reglas detalladas viven en **`.cursor/rules/firebase-functions-conventions.mdc`**.

## Layout

- `functions/index.js` → solo re-exports.
- `functions/src/features/<dominio>/*.function.js` → handlers (HTTP, callable, Firestore, etc.).
- `functions/src/lib/` → utilidades y lógica compartida.

## Lib

- **`firebase.js`**: única inicialización Admin + `db`.
- **`*.service.js`**: dominio reutilizable (`sequence-code.service.js`, `trip-cost.service.js`).
- No usar nombres tipo `*-admin.js` en `lib`.

## Callable de secuencias

- Nombre exportado: **`generateSequenceCode`**. La web (`dp-proj-00-02-web`) debe usar el mismo identificador en `httpsCallable`.

## `syncTripCostFromTripAssignment` (Firestore)

- **`tripCosts` doc id** = `assignmentId` (mismo id que `tripAssignments`).
- Si **ya existe** `tripCosts/{assignmentId}`: se hace **`update`** (patch), **no** delete + create.
- Solo se **elimina** `tripCosts/{assignmentId}` cuando se **borra** la asignación.
- El **`code` del tripCost** generado por sync usa la secuencia **`trip-cost`** (no el código de `tripAssignments`). Costos **`source: manual`**: no se sobrescribe `code` en sync (solo `tripId` + auditoría).
- **`displayName`**: en sync `salary_rule` se copia de `tripAssignments.displayName`; en **`manual`** el sync fuerza `displayName: ""`.

## Tras renombrar archivos

Actualizar todos los `require("../../lib/...")` en features y validar:

```bash
cd functions && node -e "require('./index.js'); console.log('ok');"
```
