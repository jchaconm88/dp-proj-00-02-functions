// Feature: sunat-integration, Property 2: Integridad del ZIP
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import JSZip from "jszip";
import { createZip } from "./sunat-zip.service.js";

/**
 * Validates: Requirements 1.6
 *
 * Property 2: Integridad del ZIP
 * Para cualquier contenido XML arbitrario y nombre de archivo, el ZIP generado
 * SHALL contener exactamente ese archivo con ese contenido.
 */
describe("sunat-zip.service", () => {
  it("Property 2: el ZIP contiene exactamente el archivo con el contenido original", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        // xmlName no debe contener '/' ya que JSZip lo interpreta como separador de directorio
        fc.stringMatching(/^[^/]+$/),
        fc.string({ minLength: 1 }),
        async (zipName, xmlName, xmlContent) => {
          const buffer = await createZip(zipName, xmlName, xmlContent);

          expect(Buffer.isBuffer(buffer)).toBe(true);

          const loaded = await JSZip.loadAsync(buffer);
          const files = Object.keys(loaded.files);

          // Debe contener exactamente un archivo
          expect(files).toHaveLength(1);
          expect(files[0]).toBe(xmlName);

          // El contenido debe ser idéntico al original
          const content = await loaded.files[xmlName].async("string");
          expect(content).toBe(xmlContent);
        }
      )
    );
  });
});
