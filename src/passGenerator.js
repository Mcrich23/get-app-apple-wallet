/**
 * Apple Wallet pass generator using passkit-generator.
 * Creates .pkpass buffers with the user's GET dining barcode.
 *
 * For Cloudflare Workers compatibility, model files (icons, logos, pass.json)
 * are imported as binary data via wrangler module rules instead of being read
 * from the filesystem at runtime.
 */

import { Buffer } from "node:buffer";
import { PKPass } from "passkit-generator";

// Import model files as binary ArrayBuffers (wrangler "Data" rule for *.png)
import iconPng from "../models/GetCard.pass/icon.png";
import icon2xPng from "../models/GetCard.pass/icon@2x.png";
import logoPng from "../models/GetCard.pass/logo.png";
import logo2xPng from "../models/GetCard.pass/logo@2x.png";

// pass.json is imported as a text module (wrangler "Text" rule for *.json)
import passJsonText from "../models/GetCard.pass/pass.json";

/**
 * Parse a PEM string from an environment variable.
 * Env vars store PEM content with literal "\n" sequences for newlines.
 */
function parsePemBuffer(envValue) {
    if (!envValue) return undefined;
    const pem = envValue.replace(/\\n/g, "\n");
    return Buffer.from(pem);
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
    return {
        signerCert: parsePemBuffer(env.SIGNER_CERT_PEM),
        signerKey: parsePemBuffer(env.SIGNER_KEY_PEM),
        signerKeyPassphrase: env.PASS_PHRASE || undefined,
        wwdr: parsePemBuffer(env.WWDR_PEM),
    };
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
 * @param {string} [opts.webServiceURL] – URL for Apple Wallet web service callbacks
 * @param {object} [opts.env] – environment bindings (Workers) or process.env
 * @returns {Promise<Buffer>} .pkpass file buffer
 */
export async function generatePass({
    serialNumber,
    barcodePayload,
    authenticationToken,
    balanceText,
    accountName,
    webServiceURL,
    env,
}) {
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

    // Build an in-memory buffer map of the pass model files.
    // This avoids filesystem access, which is not available in Workers.
    const modelBuffers = {
        "pass.json": Buffer.from(passJsonText),
        "icon.png": Buffer.from(iconPng),
        "icon@2x.png": Buffer.from(icon2xPng),
        "logo.png": Buffer.from(logoPng),
        "logo@2x.png": Buffer.from(logo2xPng),
    };

    const pass = new PKPass(
        modelBuffers,
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

    // --- Barcode ---
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

    if (accountName) {
        pass.secondaryFields.push({
            key: "account",
            label: "ACCOUNT",
            value: accountName,
        });
    }

    pass.secondaryFields.push({
        key: "location",
        label: "CAMPUS",
        value: "UC Santa Cruz",
        textAlignment: "PKTextAlignmentRight",
    });

    return pass.getAsBuffer();
}
