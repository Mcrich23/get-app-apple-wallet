import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Validate the Authorization header against the AUTH_TOKEN environment variable.
 * Expected header: "Bearer <AUTH_TOKEN>"
 */
function verifyAuth(request) {
    const authToken = process.env.AUTH_TOKEN;
    if (!authToken) {
        return false;
    }
    const authHeader = request.headers.get("Authorization");
    return authHeader === `Bearer ${authToken}`;
}

/** JSON response helper. */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

// ─── HTTP Actions ────────────────────────────────────────────────────

const registerDevice = httpAction(async (ctx, request) => {
    if (!verifyAuth(request)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await request.json();
    const result = await ctx.runMutation(
        internal.registrations.registerDevice,
        {
            deviceLibraryIdentifier: body.deviceLibraryIdentifier,
            pushToken: body.pushToken,
            passTypeIdentifier: body.passTypeIdentifier,
            serialNumber: body.serialNumber,
            authenticationToken: body.authenticationToken,
        }
    );

    return jsonResponse(result);
});

const unregisterDevice = httpAction(async (ctx, request) => {
    if (!verifyAuth(request)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await request.json();
    const result = await ctx.runMutation(
        internal.registrations.unregisterDevice,
        {
            deviceLibraryIdentifier: body.deviceLibraryIdentifier,
            passTypeIdentifier: body.passTypeIdentifier,
            serialNumber: body.serialNumber,
        }
    );

    return jsonResponse(result);
});

const getPassesForDevice = httpAction(async (ctx, request) => {
    if (!verifyAuth(request)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const deviceLibraryIdentifier = url.searchParams.get("deviceLibraryIdentifier");
    const passTypeIdentifier = url.searchParams.get("passTypeIdentifier");

    if (!deviceLibraryIdentifier || !passTypeIdentifier) {
        return jsonResponse(
            { error: "deviceLibraryIdentifier and passTypeIdentifier are required" },
            400
        );
    }

    const result = await ctx.runQuery(
        internal.registrations.getPassesForDevice,
        {
            deviceLibraryIdentifier,
            passTypeIdentifier,
            passesUpdatedSince: url.searchParams.get("passesUpdatedSince") || null,
        }
    );

    return jsonResponse(result);
});

const touchPass = httpAction(async (ctx, request) => {
    if (!verifyAuth(request)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await request.json();
    await ctx.runMutation(internal.registrations.touchPass, {
        passTypeIdentifier: body.passTypeIdentifier,
        serialNumber: body.serialNumber,
    });

    return jsonResponse({ ok: true });
});

// ─── Router ──────────────────────────────────────────────────────────

const http = httpRouter();

http.route({
    path: "/api/registerDevice",
    method: "POST",
    handler: registerDevice,
});

http.route({
    path: "/api/unregisterDevice",
    method: "POST",
    handler: unregisterDevice,
});

http.route({
    path: "/api/getPassesForDevice",
    method: "GET",
    handler: getPassesForDevice,
});

http.route({
    path: "/api/touchPass",
    method: "POST",
    handler: touchPass,
});

// ─── Per-pass auth token lookup ──────────────────────────────────────

const getPassAuthToken = httpAction(async (ctx, request) => {
    if (!verifyAuth(request)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);
    const passTypeIdentifier = url.searchParams.get("passTypeIdentifier");
    const serialNumber = url.searchParams.get("serialNumber");

    if (!passTypeIdentifier || !serialNumber) {
        return jsonResponse(
            { error: "passTypeIdentifier and serialNumber are required" },
            400
        );
    }

    const token = await ctx.runQuery(
        internal.registrations.getPassAuthToken,
        { passTypeIdentifier, serialNumber }
    );

    return jsonResponse({ authenticationToken: token });
});

http.route({
    path: "/api/getPassAuthToken",
    method: "GET",
    handler: getPassAuthToken,
});

export default http;
