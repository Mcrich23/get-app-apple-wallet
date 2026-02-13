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
                ? "https://api.development.push.apple.com"
                : "https://api.push.apple.com";

        console.log(
            `[APNs] Sending push notifications to ${tokens.length} device(s)`
        );

        // Send push to each device
        const results = await Promise.allSettled(
            tokens.map(async ({ pushToken, passTypeIdentifier }) => {
                const response = await fetch(
                    `${apnsHost}/3/device/${pushToken}`,
                    {
                        method: "POST",
                        headers: {
                            authorization: `bearer ${jwt}`,
                            "apns-topic": passTypeIdentifier,
                            "apns-push-type": "background",
                            "apns-priority": "5",
                        },
                        body: JSON.stringify({}),
                    }
                );

                if (!response.ok) {
                    const errorBody = await response.text();
                    console.error(
                        `[APNs] Push failed for token ${pushToken.substring(0, 8)}...: ${response.status} ${errorBody}`
                    );
                }

                return { pushToken, status: response.status };
            })
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
    },
});
