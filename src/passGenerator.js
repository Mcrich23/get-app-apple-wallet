/**
 * Apple Wallet pass generator using passkit-generator.
 * Creates .pkpass buffers with the user's GET dining barcode.
 */

const path = require("path");
const { PKPass } = require("passkit-generator");

/**
 * Parse a PEM string from an environment variable.
 * Env vars store PEM content with literal "\n" sequences for newlines.
 * Returns a Buffer, or undefined if the env var is not set.
 */
function parsePemEnv(envValue) {
    if (!envValue) return undefined;
    return Buffer.from(envValue.replace(/\\n/g, "\n"));
}

/**
 * Load signing certificates from environment variables.
 *
 * Expected env vars:
 *   SIGNER_CERT_PEM – signerCert.pem contents
 *   SIGNER_KEY_PEM  – signerKey.pem contents
 *   WWDR_PEM        – wwdr.pem contents
 */
function loadCertificates() {
    const certs = {
        signerCert: parsePemEnv(process.env.SIGNER_CERT_PEM),
        signerKeyPassphrase: process.env.PASS_PHRASE || undefined,
    };

    certs.signerKey = parsePemEnv(process.env.SIGNER_KEY_PEM);
    certs.wwdr = parsePemEnv(process.env.WWDR_PEM);

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
}) {
    const certs = loadCertificates();

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

    const modelPath = path.resolve(__dirname, "..", "models", "GetCard.pass");

    const pass = await PKPass.from(
        {
            model: modelPath,
            certificates: {
                wwdr: certs.wwdr,
                signerCert: certs.signerCert,
                signerKey: certs.signerKey,
                signerKeyPassphrase: certs.signerKeyPassphrase,
            },
        },
        {
            serialNumber,
            authenticationToken,
            webServiceURL: process.env.WEB_SERVICE_URL || "",
            organizationName: "UCSC GET Card",
            description: "UCSC GET Dining Card",
            logoText: "GET Card",
        }
    );

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

module.exports = { generatePass };
