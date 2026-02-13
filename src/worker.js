/**
 * Cloudflare Workers entry point.
 * Replaces Express with the Workers fetch handler.
 *
 * Environment variables / secrets are accessed via `env` (the second arg
 * to `fetch`), NOT `process.env`.  Each binding you set in wrangler.jsonc
 * or via `wrangler secret put` appears as a property on `env`.
 */

import { v4 as uuidv4 } from "uuid";
import { authenticatePIN, retrieveBarcode, retrieveAccounts } from "./getClient";
import { generatePass } from "./passGenerator";
import { getConvexClient } from "./convexClient";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Simple path + method router. */
function matchRoute(method, pattern, url) {
    if (url.method !== method && method !== "ALL") return null;
    const urlPath = new URL(url.url).pathname;
    const patternParts = pattern.split("/");
    const pathParts = urlPath.split("/");
    if (patternParts.length !== pathParts.length) return null;

    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(":")) {
            params[patternParts[i].slice(1)] = pathParts[i];
        } else if (patternParts[i] !== pathParts[i]) {
            return null;
        }
    }
    return params;
}

/** Verify Apple Wallet auth header. */
function verifyAppleAuth(request, env) {
    const authHeader = request.headers.get("Authorization");
    return authHeader && authHeader === `ApplePass ${env.AUTH_TOKEN}`;
}

/** JSON response helper. */
function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

/**
 * Generate a fresh pass buffer by fetching live data from the GET API.
 */
async function buildPassBuffer(env, id, code) {
    const pin = code || env.GET_PIN;
    const deviceId = id || env.GET_DEVICE_ID;

    if (!pin || !deviceId) {
        throw new Error("Missing pin (code) or deviceId (id). Set via query params or secrets.");
    }

    // Use deviceId as serialNumber if available, or fallback to UUID
    const serialNumber = deviceId || uuidv4();

    const sessionId = await authenticatePIN(pin, deviceId);
    const barcodePayload = await retrieveBarcode(sessionId);
    const accounts = await retrieveAccounts(sessionId);

    const activeAccounts = accounts.filter(
        (a) => a.isActive && a.isAccountTenderActive
    );
    const totalBalance = activeAccounts.reduce(
        (sum, a) => sum + (a.balance || 0),
        0
    );
    const balanceText = `$${totalBalance.toFixed(2)}`;

    const primaryAccount =
        activeAccounts.find((a) => a.accountType === 3) || activeAccounts[0];
    const accountName = primaryAccount
        ? primaryAccount.accountDisplayName
        : "GET Account";

    return generatePass({
        serialNumber,
        barcodePayload,
        authenticationToken: env.AUTH_TOKEN,
        balanceText,
        accountName,
        webServiceURL: env.WEB_SERVICE_URL || "",
        env,
    });
}

// ─── Landing page HTML ───────────────────────────────────────────────

const LANDING_HTML = `<!DOCTYPE html>
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
    .input-group { margin-bottom: 20px; text-align: left; }
    label { display: block; margin-bottom: 5px; font-size: 0.9em; }
    input { width: 100%; padding: 10px; border-radius: 8px; border: none; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎓 GET Card</h1>
    <p>Enter your details to generate your pass.</p>
    <form action="/pass" method="GET">
      <div class="input-group">
        <label for="id">Device ID</label>
        <input type="text" name="id" placeholder="Device ID" required>
        <label for="code">PIN Code</label>
        <input type="text" name="code" placeholder="PIN Code" required>
      </div>
      <button class="btn" type="submit">Add to Apple Wallet</button>
    </form>
    <p class="sub">Your barcode will automatically refresh.</p>
  </div>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════
// WORKER FETCH HANDLER
// ═══════════════════════════════════════════════════════════════════════

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        let params;

        try {
            // ── Landing page ──
            if (request.method === "GET" && url.pathname === "/") {
                return new Response(LANDING_HTML, {
                    headers: { "Content-Type": "text/html;charset=UTF-8" },
                });
            }

            // ── Download pass ──
            if (request.method === "GET" && url.pathname === "/pass") {
                const id = url.searchParams.get("id");
                const code = url.searchParams.get("code");

                // Allow fallback if not provided in URL
                const passBuffer = await buildPassBuffer(env, id, code);

                const filename = id ? `GetCard-${id}.pkpass` : "GetCard.pkpass";

                return new Response(passBuffer, {
                    headers: {
                        "Content-Type": "application/vnd.apple.pkpass",
                        "Content-Disposition": `attachment; filename="${filename}"`,
                        "Last-Modified": new Date().toUTCString(),
                    },
                });
            }

            // ── Apple Wallet: register device ──
            if (
                (params = matchRoute(
                    "POST",
                    "/v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber",
                    request
                ))
            ) {
                if (!verifyAppleAuth(request, env)) return json({ message: "Unauthorized" }, 401);

                const body = await request.json();
                if (!body.pushToken) return json({ message: "pushToken required" }, 400);

                const convex = getConvexClient(env);
                const result = await convex.registerDevice({
                    deviceLibraryIdentifier: params.deviceLibId,
                    pushToken: body.pushToken,
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                });

                const status = result.isNew ? 201 : 200;
                const message = result.isNew
                    ? "Registration created"
                    : "Registration already exists";

                console.log(`[Register] device=${params.deviceLibId} serial=${params.serialNumber} status=${status}`);
                return json({ message }, status);
            }

            // ── Apple Wallet: list passes for device ──
            if (
                (params = matchRoute(
                    "GET",
                    "/v1/devices/:deviceLibId/registrations/:passTypeId",
                    request
                ))
            ) {
                const passesUpdatedSince =
                    new URL(request.url).searchParams.get("passesUpdatedSince") || null;

                const convex = getConvexClient(env);
                const result = await convex.getPassesForDevice({
                    deviceLibraryIdentifier: params.deviceLibId,
                    passTypeIdentifier: params.passTypeId,
                    passesUpdatedSince,
                });

                if (result.serialNumbers.length === 0) {
                    return new Response(null, { status: 204 });
                }

                return json({
                    serialNumbers: result.serialNumbers,
                    lastUpdated: result.lastUpdated,
                });
            }

            // ── Apple Wallet: get latest pass ──
            if (
                (params = matchRoute(
                    "GET",
                    "/v1/passes/:passTypeId/:serialNumber",
                    request
                ))
            ) {
                if (!verifyAppleAuth(request, env)) return json({ message: "Unauthorized" }, 401);

                console.log(`[Update] Generating fresh pass for serial=${params.serialNumber}`);
                const passBuffer = await buildPassBuffer(env, params.serialNumber);

                // Touch the pass in Convex to track when it was last served
                const convex = getConvexClient(env);
                await convex.touchPass({
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                });

                return new Response(passBuffer, {
                    headers: {
                        "Content-Type": "application/vnd.apple.pkpass",
                        "Content-Disposition": `attachment; filename="${params.serialNumber}.pkpass"`,
                        "Last-Modified": new Date().toUTCString(),
                    },
                });
            }

            // ── Apple Wallet: unregister device ──
            if (
                (params = matchRoute(
                    "DELETE",
                    "/v1/devices/:deviceLibId/registrations/:passTypeId/:serialNumber",
                    request
                ))
            ) {
                if (!verifyAppleAuth(request, env)) return json({ message: "Unauthorized" }, 401);

                const convex = getConvexClient(env);
                const result = await convex.unregisterDevice({
                    deviceLibraryIdentifier: params.deviceLibId,
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                });

                console.log(`[Unregister] device=${params.deviceLibId} serial=${params.serialNumber} deleted=${result.deleted}`);
                return json({
                    message: result.deleted
                        ? "Registration deleted"
                        : "No registration found",
                });
            }

            // ── Apple Wallet: log endpoint ──
            if (request.method === "POST" && url.pathname === "/v1/log") {
                const body = await request.json();
                if (body.logs && Array.isArray(body.logs)) {
                    body.logs.forEach((log) => console.log("[Apple Wallet Log]", log));
                }
                return new Response(null, { status: 200 });
            }

            // ── 404 ──
            return json({ error: "Not found" }, 404);
        } catch (err) {
            console.error("Worker error:", err);
            return json({ error: err.message }, 500);
        }
    },
};
