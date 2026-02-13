import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// ─── Device Registration ─────────────────────────────────────────────

/**
 * Register a device for push notifications on a pass.
 * Internal only — called via authenticated HTTP endpoint.
 *
 * Returns { isNew: boolean } indicating whether this is a new registration.
 */
export const registerDevice = internalMutation({
    args: {
        deviceLibraryIdentifier: v.string(),
        pushToken: v.string(),
        passTypeIdentifier: v.string(),
        serialNumber: v.string(),
        authenticationToken: v.string(),
    },
    handler: async (ctx, args) => {
        // Find or create device
        const existingDevice = await ctx.db
            .query("devices")
            .withIndex("by_device_lib_id", (q) =>
                q.eq("deviceLibraryIdentifier", args.deviceLibraryIdentifier)
            )
            .unique();

        let deviceId;
        if (existingDevice) {
            deviceId = existingDevice._id;
            // Update push token if changed
            if (existingDevice.pushToken !== args.pushToken) {
                await ctx.db.patch(deviceId, { pushToken: args.pushToken });
            }
        } else {
            deviceId = await ctx.db.insert("devices", {
                deviceLibraryIdentifier: args.deviceLibraryIdentifier,
                pushToken: args.pushToken,
            });
        }

        // Find or create pass
        const existingPass = await ctx.db
            .query("passes")
            .withIndex("by_pass_type_and_serial", (q) =>
                q
                    .eq("passTypeIdentifier", args.passTypeIdentifier)
                    .eq("serialNumber", args.serialNumber)
            )
            .unique();

        let passId;
        if (existingPass) {
            passId = existingPass._id;
            // Update auth token if changed
            if (existingPass.authenticationToken !== args.authenticationToken) {
                await ctx.db.patch(passId, { authenticationToken: args.authenticationToken });
            }
        } else {
            passId = await ctx.db.insert("passes", {
                passTypeIdentifier: args.passTypeIdentifier,
                serialNumber: args.serialNumber,
                authenticationToken: args.authenticationToken,
                lastUpdated: Date.now(),
            });
        }

        // Check if registration already exists
        const existingRegistration = await ctx.db
            .query("registrations")
            .withIndex("by_device_and_pass", (q) =>
                q.eq("deviceId", deviceId).eq("passId", passId)
            )
            .unique();

        if (existingRegistration) {
            return { isNew: false };
        }

        await ctx.db.insert("registrations", {
            deviceId,
            passId,
        });

        return { isNew: true };
    },
});

/**
 * Unregister a device from a pass.
 * Internal only — called via authenticated HTTP endpoint.
 */
export const unregisterDevice = internalMutation({
    args: {
        deviceLibraryIdentifier: v.string(),
        passTypeIdentifier: v.string(),
        serialNumber: v.string(),
    },
    handler: async (ctx, args) => {
        const device = await ctx.db
            .query("devices")
            .withIndex("by_device_lib_id", (q) =>
                q.eq("deviceLibraryIdentifier", args.deviceLibraryIdentifier)
            )
            .unique();

        if (!device) return { deleted: false };

        const pass = await ctx.db
            .query("passes")
            .withIndex("by_pass_type_and_serial", (q) =>
                q
                    .eq("passTypeIdentifier", args.passTypeIdentifier)
                    .eq("serialNumber", args.serialNumber)
            )
            .unique();

        if (!pass) return { deleted: false };

        const registration = await ctx.db
            .query("registrations")
            .withIndex("by_device_and_pass", (q) =>
                q.eq("deviceId", device._id).eq("passId", pass._id)
            )
            .unique();

        if (!registration) return { deleted: false };

        await ctx.db.delete(registration._id);

        // Clean up: if device has no more registrations, delete the device
        const remainingRegistrations = await ctx.db
            .query("registrations")
            .withIndex("by_device", (q) => q.eq("deviceId", device._id))
            .first();

        if (!remainingRegistrations) {
            await ctx.db.delete(device._id);
        }

        return { deleted: true };
    },
});

// ─── Pass Queries ────────────────────────────────────────────────────

/**
 * Get serial numbers of passes registered to a device that have been updated
 * since a given timestamp.
 * Internal only — called via authenticated HTTP endpoint.
 */
export const getPassesForDevice = internalQuery({
    args: {
        deviceLibraryIdentifier: v.string(),
        passTypeIdentifier: v.string(),
        passesUpdatedSince: v.optional(v.union(v.string(), v.null())),
    },
    handler: async (ctx, args) => {
        const device = await ctx.db
            .query("devices")
            .withIndex("by_device_lib_id", (q) =>
                q.eq("deviceLibraryIdentifier", args.deviceLibraryIdentifier)
            )
            .unique();

        if (!device) return { serialNumbers: [], lastUpdated: null };

        const registrations = await ctx.db
            .query("registrations")
            .withIndex("by_device", (q) => q.eq("deviceId", device._id))
            .collect();

        if (registrations.length === 0) {
            return { serialNumbers: [], lastUpdated: null };
        }

        const passIds = registrations.map((r) => r.passId);
        const passes = await Promise.all(passIds.map((id) => ctx.db.get(id)));

        const sinceTimestamp = args.passesUpdatedSince
            ? parseInt(args.passesUpdatedSince, 10) || 0
            : 0;

        const filteredPasses = passes.filter(
            (p) =>
                p !== null &&
                p.passTypeIdentifier === args.passTypeIdentifier &&
                p.lastUpdated > sinceTimestamp
        );

        if (filteredPasses.length === 0) {
            return { serialNumbers: [], lastUpdated: null };
        }

        const serialNumbers = filteredPasses.map((p) => p.serialNumber);
        const lastUpdated = Math.max(
            ...filteredPasses.map((p) => p.lastUpdated)
        ).toString();

        return { serialNumbers, lastUpdated };
    },
});

/**
 * Touch a pass to mark it as updated (updates the lastUpdated timestamp).
 * Internal only — called via authenticated HTTP endpoint.
 */
export const touchPass = internalMutation({
    args: {
        passTypeIdentifier: v.string(),
        serialNumber: v.string(),
    },
    handler: async (ctx, args) => {
        const pass = await ctx.db
            .query("passes")
            .withIndex("by_pass_type_and_serial", (q) =>
                q
                    .eq("passTypeIdentifier", args.passTypeIdentifier)
                    .eq("serialNumber", args.serialNumber)
            )
            .unique();

        if (pass) {
            await ctx.db.patch(pass._id, { lastUpdated: Date.now() });
        }
    },
});

/**
 * Look up the authentication token for a specific pass.
 * Used to verify Apple Wallet API requests per-pass.
 */
export const getPassAuthToken = internalQuery({
    args: {
        passTypeIdentifier: v.string(),
        serialNumber: v.string(),
    },
    handler: async (ctx, args) => {
        const pass = await ctx.db
            .query("passes")
            .withIndex("by_pass_type_and_serial", (q) =>
                q
                    .eq("passTypeIdentifier", args.passTypeIdentifier)
                    .eq("serialNumber", args.serialNumber)
            )
            .unique();

        if (!pass) return null;
        return pass.authenticationToken;
    },
});

// ─── Push Notification Support ───────────────────────────────────────

/**
 * Get all unique push tokens for registered devices.
 * Used by the cron job to send APNs push notifications.
 */
export const getAllPushTokens = internalQuery({
    args: {},
    handler: async (ctx) => {
        const registrations = await ctx.db.query("registrations").collect();

        if (registrations.length === 0) return [];

        // Get unique device IDs
        const deviceIds = [...new Set(registrations.map((r) => r.deviceId))];
        const devices = await Promise.all(
            deviceIds.map((id) => ctx.db.get(id))
        );

        // Also get pass type identifiers for APNs topic
        const passIds = [...new Set(registrations.map((r) => r.passId))];
        const passes = await Promise.all(passIds.map((id) => ctx.db.get(id)));

        const passTypeId =
            passes.find((p) => p !== null)?.passTypeIdentifier || "";

        return devices
            .filter((d) => d !== null)
            .map((d) => ({
                pushToken: d.pushToken,
                passTypeIdentifier: passTypeId,
            }));
    },
});

/**
 * Mark all passes as updated (bump lastUpdated timestamp).
 * Called by the cron job before sending push notifications.
 */
export const touchAllPasses = internalMutation({
    args: {},
    handler: async (ctx) => {
        const passes = await ctx.db.query("passes").collect();
        const now = Date.now();
        await Promise.all(
            passes.map((pass) => ctx.db.patch(pass._id, { lastUpdated: now }))
        );
        return passes.length;
    },
});
