/**
 * Apple Wallet pass generator using passkit-generator.
 * Creates .pkpass buffers with the user's GET dining barcode.
 */

import { PKPass } from "passkit-generator";

// Import model assets as ArrayBuffers (requires wrangler module rules)
import passJsonBuffer from "../models/GetCard.pass/pass.json";
import iconBuffer from "../models/GetCard.pass/icon.png";
import icon2xBuffer from "../models/GetCard.pass/icon@2x.png";
import logoBuffer from "../models/GetCard.pass/logo.png";
import logo2xBuffer from "../models/GetCard.pass/logo@2x.png";
import stripBuffer from "../models/GetCard.pass/strip.png";
import strip2xBuffer from "../models/GetCard.pass/strip@2x.png";

/**
 * Parse a PEM string from an environment variable.
 * Env vars store PEM content with literal "\n" sequences for newlines.
 * Returns a Buffer, or undefined if the env var is not set.
 */
function parsePemEnv(envValue) {
    if (!envValue) return undefined;
    // Remove surrounding quotes if present and trim whitespace
    let pem = envValue.trim();
    if ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'"))) {
        pem = pem.slice(1, -1);
    }
    // Replace literal "\n" sequences with actual newlines
    pem = pem.replace(/\\n/g, "\n");

    // Workers: use TextEncoder if Buffer is unavailable
    if (typeof Buffer !== "undefined") {
        return Buffer.from(pem);
    }
    return new TextEncoder().encode(pem);
}

/**
 * Load signing certificates from environment variables.
 *
 * Expected env vars:
 *   SIGNER_CERT_PEM – signerCert.pem contents
 *   SIGNER_KEY_PEM  – signerKey.pem contents
 *   WWDR_PEM        – wwdr.pem contents
 */
function loadCertificates(env) {
    const certs = {
        signerCert: parsePemEnv(env.SIGNER_CERT_PEM),
        signerKeyPassphrase: env.PASS_PHRASE || undefined,
    };

    certs.signerKey = parsePemEnv(env.SIGNER_KEY_PEM);
    certs.wwdr = parsePemEnv(env.WWDR_PEM);

    return certs;
}

/**
 * Generate a .pkpass buffer for a user.
 *
 * @param {object} opts
 * @param {string} opts.serialNumber  – unique ID for this pass
 * @param {string} opts.barcodePayload – the barcode string from GET API
 * @param {string} opts.authenticationToken – token for Apple Wallet callbacks
 * @param {string} [opts.balanceText] – formatted balance string, e.g. "$42.50"
 * @param {string} [opts.accountName] – e.g. "Flexi Dollars"
 * @returns {Promise<Buffer>} .pkpass file buffer
 */
async function generatePass({
    serialNumber,
    barcodePayload,
    authenticationToken,
    balanceText,
    accountName,
    webServiceURL,
    env,
}) {
    // Use provided env, fall back to process.env for Node.js
    const e = env || process.env;
    const certs = loadCertificates(e);

    if (!certs.signerCert) {
        throw new Error(
            "SIGNER_CERT_PEM env var is not set. Please set it to the contents of your signerCert.pem."
        );
    }
    if (!certs.signerKey) {
        throw new Error(
            "SIGNER_KEY_PEM env var is not set. Please set it to the contents of your signerKey.pem."
        );
    }
    if (!certs.wwdr) {
        throw new Error(
            "WWDR_PEM env var is not set. Download Apple's WWDR certificate from https://www.apple.com/certificateauthority/ and set the env var."
        );
    }

    // --- Parse pass.json ---
    const pass = new PKPass(
        {
            "pass.json": Buffer.from(passJsonBuffer),
        },
        {
            wwdr: certs.wwdr,
            signerCert: certs.signerCert,
            signerKey: certs.signerKey,
            signerKeyPassphrase: certs.signerKeyPassphrase,
        },
        {
            serialNumber,
            authenticationToken,
            webServiceURL: webServiceURL || e.WEB_SERVICE_URL || "",
            organizationName: "UCSC GET Card",
            description: "UCSC GET Dining Card",
            logoText: "GET Card",
        }
    );
    // Inject images
    pass.addBuffer("icon.png", Buffer.from(iconBuffer));
    pass.addBuffer("icon@2x.png", Buffer.from(icon2xBuffer));
    pass.addBuffer("logo.png", Buffer.from(logoBuffer));
    pass.addBuffer("logo@2x.png", Buffer.from(logo2xBuffer));

    // --- Barcode ---
    // The GET app uses PDF417 barcodes scanned at UCSC dining locations
    pass.setBarcodes({
        message: barcodePayload,
        format: "PKBarcodeFormatPDF417",
        messageEncoding: "iso-8859-1",
    });

    // --- Fields ---
    if (balanceText) {
        pass.headerFields.push({
            key: "balance",
            label: "BALANCE",
            value: balanceText,
        });
    }

    // if (accountName) {
    //     pass.secondaryFields.push({
    //         key: "account",
    //         label: "ACCOUNT",
    //         value: accountName,
    //     });
    // }

    pass.secondaryFields.push({
        key: "location",
        label: "CAMPUS",
        value: "UC Santa Cruz",
        textAlignment: "PKTextAlignmentRight",
    });

    return pass.getAsBuffer();
}

export { generatePass };
