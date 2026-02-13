"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Create a base64url-encoded string from raw bytes.
 */
function base64urlEncode(buffer) {
    return Buffer.from(buffer)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Build a JWT for APNs authentication using the ES256 algorithm.
 * Uses Node.js built-in crypto module (available in Convex "use node" actions).
 */
async function buildApnsJwt(keyId, teamId, privateKeyPem) {
    const crypto = await import("crypto");

    const header = { alg: "ES256", kid: keyId, typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: teamId, iat: now };

    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    // Sign with ES256 (ECDSA using P-256 and SHA-256)
    const sign = crypto.createSign("SHA256");
    sign.update(signingInput);
    sign.end();

    // The .p8 key is in PKCS#8 PEM format
    const signature = sign.sign(
        { key: privateKeyPem, dsaEncoding: "ieee-p1363" },
    );

    const signatureB64 = base64urlEncode(signature);
    return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Send an empty push notification to APNs to trigger a pass update.
 * Apple Wallet passes use empty push payloads ("{}").
 *
 * Environment variables required (set in Convex dashboard):
 *   APNS_KEY_ID      – 10-character Key ID from Apple Developer portal
 *   APNS_TEAM_ID     – Your Apple Developer Team ID
 *   APNS_PRIVATE_KEY – Contents of the .p8 auth key file
 *   APNS_ENVIRONMENT – "production" or "development" (defaults to "production")
 */
export const sendPushNotifications = internalAction({
    args: {},
    handler: async (ctx) => {
        const keyId = process.env.APNS_KEY_ID;
        const teamId = process.env.APNS_TEAM_ID;
        const privateKeyPem = process.env.APNS_PRIVATE_KEY;
        const apnsEnv = process.env.APNS_ENVIRONMENT || "production";

        if (!keyId || !teamId || !privateKeyPem) {
            console.log(
                "[APNs] Skipping push: APNS_KEY_ID, APNS_TEAM_ID, or APNS_PRIVATE_KEY not configured"
            );
            return;
        }

        // Restore newlines in the private key PEM (env vars use literal \n)
        const key = privateKeyPem.replace(/\\n/g, "\n");

        // Get all registered push tokens
        const tokens = await ctx.runQuery(
            internal.registrations.getAllPushTokens
        );

        if (tokens.length === 0) {
            console.log("[APNs] No registered devices to notify");
            return;
        }

        // Mark all passes as updated so iOS fetches fresh data
        await ctx.runMutation(internal.registrations.touchAllPasses);

        // Build JWT for APNs authentication
        const jwt = await buildApnsJwt(keyId, teamId, key);

        const apnsHost =
            apnsEnv === "development"
                ? "api.development.push.apple.com"
                : "api.push.apple.com";

        console.log(
            `[APNs] Sending push notifications to ${tokens.length} device(s)`
        );

        // APNs requires HTTP/2 – Node's built-in fetch (undici) only supports HTTP/1.1
        const http2 = await import("http2");

        /**
         * Send a single push notification over an HTTP/2 session.
         * Returns a promise that resolves with { pushToken, status }.
         */
        function sendPush(session, pushToken, passTypeIdentifier) {
            return new Promise((resolve, reject) => {
                const req = session.request({
                    ":method": "POST",
                    ":path": `/3/device/${pushToken}`,
                    authorization: `bearer ${jwt}`,
                    "apns-topic": passTypeIdentifier,
                    "apns-push-type": "background",
                    "apns-priority": "5",
                    "content-type": "application/json",
                });

                req.on("response", (headers) => {
                    const status = headers[":status"];
                    let body = "";
                    req.on("data", (chunk) => { body += chunk; });
                    req.on("end", () => {
                        if (status !== 200) {
                            console.error(
                                `[APNs] Push failed for token ${pushToken.substring(0, 8)}...: ${status} ${body}`
                            );
                        }
                        resolve({ pushToken, status });
                    });
                });

                req.on("error", (err) => reject(err));

                req.write(JSON.stringify({}));
                req.end();
            });
        }

        // Open a single HTTP/2 session and multiplex all pushes over it
        const session = http2.connect(`https://${apnsHost}`);

        try {
            const results = await Promise.allSettled(
                tokens.map(({ pushToken, passTypeIdentifier }) =>
                    sendPush(session, pushToken, passTypeIdentifier)
                )
            );

            let succeeded = 0;
            let failed = 0;

            for (const result of results) {
                if (result.status === "fulfilled" && result.value.status === 200) {
                    succeeded++;
                } else {
                    failed++;
                    if (result.status === "rejected") {
                        console.error(
                            `[APNs] Push threw error: ${result.reason}`
                        );
                    } else {
                        const { pushToken, status } = result.value;
                        console.error(
                            `[APNs] Push failed for token ${pushToken.substring(0, 8)}...: HTTP ${status}`
                        );
                    }
                }
            }

            console.log(
                `[APNs] Push results: ${succeeded} succeeded, ${failed} failed`
            );
        } finally {
            session.close();
        }
    },
});
