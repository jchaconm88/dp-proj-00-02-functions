const forge = require("node-forge");
const { SignedXml } = require("xml-crypto");

/**
 * Firma un XML con el certificado PKCS#12 de la empresa usando XMLDSig RSA-SHA1.
 * Requerido por SUNAT para comprobantes electrónicos UBL 2.1.
 *
 * @param {string} xmlString    - XML sin firmar (debe contener ext:UBLExtensions > ext:UBLExtension > ext:ExtensionContent)
 * @param {string} certBase64   - Certificado PKCS#12 en base64
 * @param {string} certPassword - Contraseña del certificado PKCS#12
 * @returns {Promise<string>} XML firmado con ds:Signature dentro de ext:ExtensionContent
 */
async function signXml(xmlString, certBase64, certPassword) {
  // 1. Decodificar base64 → buffer binario → DER
  const certBuffer = Buffer.from(certBase64, "base64");
  const certDer = forge.util.createBuffer(certBuffer.toString("binary"));

  // 2. Parsear el PKCS#12
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(certDer), certPassword);
  } catch (err) {
    throw new Error(`Certificado inválido o contraseña incorrecta: ${err.message}`);
  }

  // 3. Extraer clave privada
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag =
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (!keyBag || !keyBag.key) {
    throw new Error("No se encontró la clave privada en el certificado PKCS#12.");
  }
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  // 4. Extraer certificado público
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag = certBags[forge.pki.oids.certBag]?.[0];

  if (!certBag || !certBag.cert) {
    throw new Error("No se encontró el certificado público en el PKCS#12.");
  }
  const certPem = forge.pki.certificateToPem(certBag.cert);

  // 5. Configurar SignedXml con clave privada y algoritmo RSA-SHA1 (requerido por SUNAT)
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });

  // 6. Agregar referencia con transforms requeridos por SUNAT
  sig.addReference({
    xpath: "//*[local-name(.)='Invoice']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    uri: "",
    isEmptyUri: true,
  });

  // 7. Calcular la firma e insertar dentro de ext:ExtensionContent (flujo síncrono)
  sig.computeSignature(xmlString, {
    location: {
      reference: "//*[local-name(.)='ExtensionContent']",
      action: "append",
    },
    existingPrefixes: {
      ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
      ds: "http://www.w3.org/2000/09/xmldsig#",
    },
  });

  return sig.getSignedXml();
}

module.exports = { signXml };
