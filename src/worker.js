/**
 * Cloudflare Workers entry point.
 * Replaces Express with the Workers fetch handler.
 *
 * Environment variables / secrets are accessed via `env` (the second arg
 * to `fetch`), NOT `process.env`.  Each binding you set in wrangler.jsonc
 * or via `wrangler secret put` appears as a property on `env`.
 */

import { authenticatePIN, retrieveBarcode, retrieveAccounts } from "./getClient";
import { generatePass } from "./passGenerator";

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
async function buildPassBuffer(serialNumber, env) {
    const pin = env.GET_PIN;
    const deviceId = env.GET_DEVICE_ID;

    if (!pin || !deviceId) {
        throw new Error("GET_PIN and GET_DEVICE_ID must be set as secrets");
    }

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
                const serialNumber = env.GET_DEVICE_ID || crypto.randomUUID();
                const passBuffer = await buildPassBuffer(serialNumber, env);

                return new Response(passBuffer, {
                    headers: {
                        "Content-Type": "application/vnd.apple.pkpass",
                        "Content-Disposition": 'attachment; filename="GetCard.pkpass"',
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

                // TODO: store registration (D1 or KV)
                console.log(`[Register] device=${params.deviceLibId} serial=${params.serialNumber}`);
                return json({ message: "Registration created" }, 201);
            }

            // ── Apple Wallet: list passes for device ──
            if (
                (params = matchRoute(
                    "GET",
                    "/v1/devices/:deviceLibId/registrations/:passTypeId",
                    request
                ))
            ) {
                if (!verifyAppleAuth(request, env)) return json({ message: "Unauthorized" }, 401);

                // TODO: query registrations (D1 or KV)
                return new Response(null, { status: 204 });
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
                const passBuffer = await buildPassBuffer(params.serialNumber, env);

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

                // TODO: delete registration (D1 or KV)
                console.log(`[Unregister] device=${params.deviceLibId} serial=${params.serialNumber}`);
                return json({ message: "Registration deleted" });
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
