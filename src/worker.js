/**
 * Cloudflare Workers entry point.
 * Replaces Express with the Workers fetch handler.
 *
 * Environment variables / secrets are accessed via `env` (the second arg
 * to `fetch`), NOT `process.env`.  Each binding you set in wrangler.jsonc
 * or via `wrangler secret put` appears as a property on `env`.
 */

import { v4 as uuidv4 } from "uuid";
import { createPIN, generateCredentials, authenticatePIN, retrieveBarcode, retrieveAccounts } from "./getClient";
import { generatePass } from "./passGenerator";
import { getConvexClient } from "./convexClient";
import passJsonBuffer from "../models/GetCard.pass/pass.json";

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

/** Verify Apple Wallet auth header against per-pass token stored in Convex. */
async function verifyAppleAuth(request, env, passTypeId, serialNumber) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("ApplePass ")) return false;

    const providedToken = authHeader.slice("ApplePass ".length);
    try {
        const convex = getConvexClient(env);
        const expectedToken = await convex.getPassAuthToken({
            passTypeIdentifier: passTypeId,
            serialNumber,
        });
        return expectedToken && providedToken === expectedToken;
    } catch (err) {
        console.error("Auth token lookup failed:", err);
        return false;
    }
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
async function buildPassBuffer(env, request, id, code, existingAuthToken) {
    // Derive webServiceURL from the incoming request origin; env var is an optional override
    const webServiceURL = env.WEB_SERVICE_URL || new URL(request.url).origin;
    const pin = code || env.GET_PIN;
    const deviceId = id || env.GET_DEVICE_ID;

    if (!pin || !deviceId) {
        throw new Error("Missing pin (code) or deviceId (id). Set via query params or secrets.");
    }

    // Use deviceId as serialNumber if available, or fallback to UUID
    const serialNumber = deviceId || uuidv4();

    // Generate a unique random authentication token for this pass, or reuse existing
    const authenticationToken = existingAuthToken || crypto.randomUUID();

    // Parse pass.json to get passTypeIdentifier
    const passJson = JSON.parse(new TextDecoder().decode(passJsonBuffer));

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

    const passBuffer = await generatePass({
        serialNumber,
        barcodePayload,
        authenticationToken,
        balanceText,
        accountName,
        webServiceURL,
        env,
    });

    return { passBuffer, serialNumber, authenticationToken, passTypeIdentifier: passJson.passTypeIdentifier };
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
      max-width: 460px;
      border: 1px solid rgba(255,255,255,0.15);
    }
    h1 { font-size: 1.8em; margin-bottom: 8px; }
    p { color: rgba(255,255,255,0.7); margin-bottom: 20px; }
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
      border: none;
      cursor: pointer;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
    .btn:disabled { opacity: 0.5; transform: none; cursor: not-allowed; }
    .sub { margin-top: 16px; font-size: 0.85em; color: rgba(255,255,255,0.45); }
    .steps { text-align: left; margin-bottom: 24px; }
    .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    .step-num {
      background: rgba(255,255,255,0.2);
      width: 28px; height: 28px; min-width: 28px;
      border-radius: 50%; display: flex;
      align-items: center; justify-content: center;
      font-weight: 700; font-size: 0.85em;
    }
    .step-num.active { background: white; color: #003366; }
    .step-content p { margin-bottom: 8px; color: rgba(255,255,255,0.85); }
    .link-input {
      width: 100%; padding: 12px; border-radius: 10px;
      border: 2px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3);
      color: white; font-size: 0.95em; outline: none;
      transition: border-color 0.2s;
    }
    .link-input:focus { border-color: rgba(255,255,255,0.5); }
    .link-input::placeholder { color: rgba(255,255,255,0.35); }
    .error { color: #ff6b6b; font-size: 0.85em; margin-top: 8px; display: none; }
    .loading { display: none; margin: 20px auto; }
    .loading.show { display: block; }
    .spinner {
      width: 32px; height: 32px; border: 3px solid rgba(255,255,255,0.2);
      border-top-color: white; border-radius: 50%; margin: 0 auto 10px;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>\ud83c\udf93 GET Card</h1>
    <p>Add your UCSC dining barcode to Apple Wallet.</p>
    <div id="form-section">
      <div class="steps">
        <div class="step">
          <div class="step-num active">1</div>
          <div class="step-content">
            <p>Sign in with your UCSC account:</p>
            <a class="btn" href="https://get.cbord.com/ucsc/full/login.php?mobileapp=1" target="_blank" rel="noopener noreferrer" style="font-size:0.9em; padding:10px 20px;">Log in with UCSC \u2197</a>
          </div>
        </div>
        <div class="step">
          <div class="step-num active">2</div>
          <div class="step-content">
            <p>Once you see \u201cvalidated\u201d, copy the page URL and paste it here:</p>
            <input type="text" id="link-input" class="link-input" placeholder="Paste the validated URL here\u2026" autocomplete="off">
            <div id="error-msg" class="error">Hmm, that doesn\u2019t look like a valid link. Try again?</div>
          </div>
        </div>
      </div>
    </div>
    <div id="loading-section" class="loading">
      <div class="spinner"></div>
      <p style="color:rgba(255,255,255,0.8)">Generating your pass\u2026</p>
    </div>
    <p class="sub">Your barcode will automatically refresh once added.</p>
  </div>
  <script>
    var input = document.getElementById('link-input');
    var errorMsg = document.getElementById('error-msg');
    var formSection = document.getElementById('form-section');
    var loadingSection = document.getElementById('loading-section');
    var UUID_RE = /([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/;

    input.addEventListener('input', function() {
      errorMsg.style.display = 'none';
      var val = input.value.trim();
      if (val.length >= 32) {
        var match = val.match(UUID_RE);
        if (match) {
          submitSession(match[1]);
        } else {
          errorMsg.style.display = 'block';
        }
      }
    });

    function submitSession(sessionId) {
      formSection.style.display = 'none';
      loadingSection.classList.add('show');
      window.location.href = '/pass?sessionId=' + encodeURIComponent(sessionId);
    }
  </script>
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
                const sessionId = url.searchParams.get("sessionId");

                let id, code;

                if (sessionId) {
                    // URL-based login flow: auto-generate credentials from session
                    const creds = generateCredentials();
                    await createPIN(sessionId, creds.deviceId, creds.pin);
                    id = creds.deviceId;
                    code = creds.pin;
                    console.log(`[Pass] Created credentials for session, deviceId=${id}`);
                } else {
                    // Legacy fallback: manual id/code params or env vars
                    id = url.searchParams.get("id");
                    code = url.searchParams.get("code");
                }

                const { passBuffer, serialNumber, authenticationToken, passTypeIdentifier } = await buildPassBuffer(env, request, id, code);

                // Store the per-pass auth token in Convex (pass record only, no device)
                const convex = getConvexClient(env);
                await convex.upsertPass({
                    passTypeIdentifier,
                    serialNumber,
                    authenticationToken,
                });

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
                if (!(await verifyAppleAuth(request, env, params.passTypeId, params.serialNumber))) return json({ message: "Unauthorized" }, 401);

                const body = await request.json();
                if (!body.pushToken) return json({ message: "pushToken required" }, 400);

                // Look up the existing auth token for this pass
                const convex = getConvexClient(env);
                const existingToken = await convex.getPassAuthToken({
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                });

                const result = await convex.registerDevice({
                    deviceLibraryIdentifier: params.deviceLibId,
                    pushToken: body.pushToken,
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                    authenticationToken: existingToken || crypto.randomUUID(),
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
                if (!(await verifyAppleAuth(request, env, params.passTypeId, params.serialNumber))) return json({ message: "Unauthorized" }, 401);

                console.log(`[Update] Generating fresh pass for serial=${params.serialNumber}`);

                // Reuse existing auth token for pass updates
                const convex = getConvexClient(env);
                const existingToken = await convex.getPassAuthToken({
                    passTypeIdentifier: params.passTypeId,
                    serialNumber: params.serialNumber,
                });

                const { passBuffer } = await buildPassBuffer(env, request, params.serialNumber, undefined, existingToken);

                // Touch the pass in Convex to track when it was last served
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
                if (!(await verifyAppleAuth(request, env, params.passTypeId, params.serialNumber))) return json({ message: "Unauthorized" }, 401);

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
