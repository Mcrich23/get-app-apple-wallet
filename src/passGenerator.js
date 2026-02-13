/**
 * Apple Wallet pass generator using passkit-generator.
 * Creates .pkpass buffers with the user's GET dining barcode.
 */

const fs = require("fs");
const path = require("path");
const { PKPass } = require("passkit-generator");

// Resolve cert paths relative to project root
const SECRETS_DIR = path.resolve(__dirname, "..", "Secrets");

/**
 * Load signing certificates from disk.
 */
function loadCertificates() {
    const signerCertPath = path.join(SECRETS_DIR, "signerCert.pem");
    const signerKeyPath = path.join(SECRETS_DIR, "signerKey.pem");
    const wwdrPath = path.join(SECRETS_DIR, "wwdr.pem");

    const certs = {
        signerCert: fs.readFileSync(signerCertPath),
        signerKeyPassphrase: process.env.PASS_PHRASE || undefined,
    };

    // signerKey and wwdr are optional at load-time so server can start
    // even if certs aren't fully configured yet
    if (fs.existsSync(signerKeyPath)) {
        certs.signerKey = fs.readFileSync(signerKeyPath);
    }
    if (fs.existsSync(wwdrPath)) {
        certs.wwdr = fs.readFileSync(wwdrPath);
    }

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

    if (!certs.signerKey) {
        throw new Error(
            "signerKey.pem not found in Secrets/. Please export your pass signing private key."
        );
    }
    if (!certs.wwdr) {
        throw new Error(
            "wwdr.pem not found in Secrets/. Download Apple's WWDR certificate from https://www.apple.com/certificateauthority/"
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
