/**
 * Convex HTTP client factory for Cloudflare Workers.
 *
 * Uses ConvexHttpClient which works in any JS runtime (no WebSocket needed).
 * The CONVEX_URL environment variable must be set to your Convex deployment URL.
 */

import { ConvexHttpClient } from "convex/browser";

/**
 * Create a ConvexHttpClient using the deployment URL from environment.
 * @param {object} env – Cloudflare Workers env bindings
 * @returns {ConvexHttpClient}
 */
export function getConvexClient(env) {
    const url = env.CONVEX_URL;
    if (!url) {
        throw new Error(
            "CONVEX_URL environment variable is not set. " +
            "Set it to your Convex deployment URL (e.g., https://your-project-123.convex.cloud)"
        );
    }
    return new ConvexHttpClient(url);
}
