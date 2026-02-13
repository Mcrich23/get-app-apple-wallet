import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    devices: defineTable({
        deviceLibraryIdentifier: v.string(),
        pushToken: v.string(),
    }).index("by_device_lib_id", ["deviceLibraryIdentifier"]),

    passes: defineTable({
        passTypeIdentifier: v.string(),
        serialNumber: v.string(),
        authenticationToken: v.string(),
        lastUpdated: v.number(),
    }).index("by_pass_type_and_serial", ["passTypeIdentifier", "serialNumber"]),

    registrations: defineTable({
        deviceId: v.id("devices"),
        passId: v.id("passes"),
    })
        .index("by_device", ["deviceId"])
        .index("by_pass", ["passId"])
        .index("by_device_and_pass", ["deviceId", "passId"]),
});
