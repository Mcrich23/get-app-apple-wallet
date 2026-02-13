import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Send push notifications to all registered devices every 3 seconds.
// This triggers Apple Wallet to fetch the latest pass data (barcode, balance).
crons.interval(
    "push pass updates",
    { seconds: 3 },
    internal.pushNotifications.sendPushNotifications
);

export default crons;
