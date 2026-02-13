/**
 * Express server implementing Apple Wallet Web Service protocol.
 * Also provides a user-facing endpoint to download a .pkpass.
 *
 * Apple spec: https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { authenticatePIN, retrieveBarcode, retrieveAccounts } = require("./getClient");
const { generatePass } = require("./passGenerator");

const app = express();
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Authenticate Apple Wallet API requests.
 * Apple sends: Authorization: ApplePass <authenticationToken>
 */
function verifyAppleAuth(req, res) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `ApplePass ${process.env.AUTH_TOKEN}`) {
        res.status(401).json({ message: "Unauthorized" });
        return false;
    }
    return true;
}

/**
 * Generate a fresh pass buffer by fetching live data from GET API.
 */
async function buildPassBuffer(serialNumber) {
    const pin = process.env.GET_PIN;
    const deviceId = process.env.GET_DEVICE_ID;

    if (!pin || !deviceId) {
        throw new Error("GET_PIN and GET_DEVICE_ID must be set in .env");
    }

    // Authenticate and fetch barcode + accounts
    const sessionId = await authenticatePIN(pin, deviceId);
    const barcodePayload = await retrieveBarcode(sessionId);
    const accounts = await retrieveAccounts(sessionId);

    // Compute total balance from active accounts
    const activeAccounts = accounts.filter(
        (a) => a.isActive && a.isAccountTenderActive
    );
    const totalBalance = activeAccounts.reduce(
        (sum, a) => sum + (a.balance || 0),
        0
    );
    const balanceText = `$${totalBalance.toFixed(2)}`;

    // Get primary account name
    const primaryAccount =
        activeAccounts.find((a) => a.accountType === 3) || activeAccounts[0];
    const accountName = primaryAccount
        ? primaryAccount.accountDisplayName
        : "GET Account";

    return generatePass({
        serialNumber,
        barcodePayload,
        authenticationToken: process.env.AUTH_TOKEN,
        balanceText,
        accountName,
    });
}

// ═══════════════════════════════════════════════════════════════════════
// USER-FACING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /pass
 * Download a fresh .pkpass file.
 * The serial number is derived from the GET credentials to stay stable.
 */
app.get("/pass", async (req, res) => {
    try {
        const serialNumber = process.env.GET_DEVICE_ID || uuidv4();
        const passBuffer = await buildPassBuffer(serialNumber);

        res.set({
            "Content-Type": "application/vnd.apple.pkpass",
            "Content-Disposition": 'attachment; filename="GetCard.pkpass"',
            "Last-Modified": new Date().toUTCString(),
        });
        res.send(passBuffer);
    } catch (err) {
        console.error("Error generating pass:", err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /
 * Simple landing page.
 */
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>GET Card – Apple Wallet</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          min-height: 100vh;
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #003366 0%, #004080 50%, #001a33 100%);
          color: white;
        }
        .card {
          background: rgba(255,255,255,0.1);
          backdrop-filter: blur(20px);
          border-radius: 20px;
          padding: 40px;
          text-align: center;
          max-width: 420px;
          border: 1px solid rgba(255,255,255,0.15);
        }
        h1 { font-size: 1.8em; margin-bottom: 8px; }
        p { color: rgba(255,255,255,0.7); margin-bottom: 24px; }
        .btn {
          display: inline-block;
          background: white;
          color: #003366;
          padding: 14px 32px;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 600;
          font-size: 1.05em;
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
        .sub { margin-top: 16px; font-size: 0.85em; color: rgba(255,255,255,0.45); }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🎓 GET Card</h1>
        <p>Add your UCSC dining barcode to Apple Wallet for quick scanning at any dining location.</p>
        <a class="btn" href="/pass">Add to Apple Wallet</a>
        <p class="sub">Your barcode will automatically refresh.</p>
      </div>
    </body>
    </html>
  `);
});

// ═══════════════════════════════════════════════════════════════════════
// APPLE WALLET WEB SERVICE ENDPOINTS
// https://developer.apple.com/documentation/walletpasses
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber
 * Register a device to receive push notifications for a pass.
 */
app.post(
    "/v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber",
    (req, res) => {
        if (!verifyAppleAuth(req, res)) return;

        const { deviceLibId, serialNumber } = req.params;
        const { pushToken } = req.body;

        if (!pushToken) {
            return res.status(400).json({ message: "pushToken required" });
        }

        console.log(
            `[Register] device=${deviceLibId} serial=${serialNumber} pushToken=${pushToken}`
        );
        res.status(201).json({ message: "Registration created" });
    }
);

/**
 * GET /v1/devices/:deviceLibId/registrations/:passTypeId
 * Get the serial numbers of passes registered for a device.
 * Query param: passesUpdatedSince (epoch seconds)
 */
app.get(
    "/v1/devices/:deviceLibId/registrations/:passTypeId",
    (req, res) => {
        if (!verifyAppleAuth(req, res)) return;

        console.log(
            `[List Passes] device=${req.params.deviceLibId} passType=${req.params.passTypeId}`
        );
        // No passes stored, return 204 No Content
        res.status(204).end();
    }
);

/**
 * GET /v1/passes/:passTypeId/:serialNumber
 * Return the latest version of a pass.
 * Apple Wallet calls this when it wants to update a pass.
 */
app.get("/v1/passes/:passTypeId/:serialNumber", async (req, res) => {
    if (!verifyAppleAuth(req, res)) return;

    try {
        const { serialNumber } = req.params;

        console.log(`[Update] Generating fresh pass for serial=${serialNumber}`);
        const passBuffer = await buildPassBuffer(serialNumber);

        res.set({
            "Content-Type": "application/vnd.apple.pkpass",
            "Content-Disposition": `attachment; filename="${serialNumber}.pkpass"`,
            "Last-Modified": new Date().toUTCString(),
        });
        res.send(passBuffer);
    } catch (err) {
        console.error("Pass update error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

/**
 * DELETE /v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber
 * Unregister a device from a pass.
 */
app.delete(
    "/v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber",
    (req, res) => {
        if (!verifyAppleAuth(req, res)) return;

        const { deviceLibId, serialNumber } = req.params;

        console.log(
            `[Unregister] device=${deviceLibId} serial=${serialNumber}`
        );
        res.json({ message: "Registration deleted" });
    }
);

/**
 * POST /v1/log
 * Apple Wallet sends error logs here.
 */
app.post("/v1/log", (req, res) => {
    const { logs } = req.body;
    if (logs && Array.isArray(logs)) {
        logs.forEach((log) => console.log("[Apple Wallet Log]", log));
    }
    res.status(200).end();
});

module.exports = app;
