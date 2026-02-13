/**
 * Authenticated HTTP client for calling Convex HTTP endpoints.
 *
 * All Convex functions are internal-only and exposed through authenticated
 * HTTP actions. This client sends requests with a Bearer token that the
 * Convex HTTP layer validates against its AUTH_TOKEN environment variable.
 *
 * Required Cloudflare Worker env vars:
 *   CONVEX_SITE_URL – Your Convex HTTP actions URL (e.g., https://your-project-123.convex.site)
 *   AUTH_TOKEN       – Shared secret matching Convex's AUTH_TOKEN env var
 */

/**
 * Create an authenticated Convex HTTP client.
 * @param {object} env – Cloudflare Workers env bindings
 */
export function getConvexClient(env) {
    const siteUrl = env.CONVEX_SITE_URL;
    if (!siteUrl) {
        throw new Error(
            "CONVEX_SITE_URL environment variable is not set. " +
            "Set it to your Convex HTTP actions URL (e.g., https://your-project-123.convex.site)"
        );
    }

    const authToken = env.AUTH_TOKEN;
    if (!authToken) {
        throw new Error("AUTH_TOKEN environment variable is not set.");
    }

    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
    };

    return {
        /**
         * Register a device for pass push notifications.
         */
        async registerDevice(args) {
            const res = await fetch(`${siteUrl}/api/registerDevice`, {
                method: "POST",
                headers,
                body: JSON.stringify(args),
            });
            if (!res.ok) throw new Error(`Convex registerDevice failed: ${res.status}`);
            return res.json();
        },

        /**
         * Get the authentication token for a specific pass.
         */
        async getPassAuthToken(args) {
            const params = new URLSearchParams({
                passTypeIdentifier: args.passTypeIdentifier,
                serialNumber: args.serialNumber,
            });
            const res = await fetch(
                `${siteUrl}/api/getPassAuthToken?${params.toString()}`,
                { method: "GET", headers }
            );
            if (!res.ok) throw new Error(`Convex getPassAuthToken failed: ${res.status}`);
            const data = await res.json();
            return data.authenticationToken;
        },

        /**
         * Unregister a device from a pass.
         */
        async unregisterDevice(args) {
            const res = await fetch(`${siteUrl}/api/unregisterDevice`, {
                method: "POST",
                headers,
                body: JSON.stringify(args),
            });
            if (!res.ok) throw new Error(`Convex unregisterDevice failed: ${res.status}`);
            return res.json();
        },

        /**
         * Get serial numbers of passes for a device updated since a timestamp.
         */
        async getPassesForDevice(args) {
            const params = new URLSearchParams({
                deviceLibraryIdentifier: args.deviceLibraryIdentifier,
                passTypeIdentifier: args.passTypeIdentifier,
            });
            if (args.passesUpdatedSince) {
                params.set("passesUpdatedSince", args.passesUpdatedSince);
            }
            const res = await fetch(
                `${siteUrl}/api/getPassesForDevice?${params.toString()}`,
                { method: "GET", headers }
            );
            if (!res.ok) throw new Error(`Convex getPassesForDevice failed: ${res.status}`);
            return res.json();
        },

        /**
         * Touch a pass to mark it as updated.
         */
        async touchPass(args) {
            const res = await fetch(`${siteUrl}/api/touchPass`, {
                method: "POST",
                headers,
                body: JSON.stringify(args),
            });
            if (!res.ok) throw new Error(`Convex touchPass failed: ${res.status}`);
            return res.json();
        },
    };
}
