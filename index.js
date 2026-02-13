/**
 * GET Card – Apple Wallet Pass Server
 * Entry point: loads environment and starts Express.
 */

require("dotenv").config();

const app = require("./src/server");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`\n  🎓 GET Card Wallet Server`);
    console.log(`  ────────────────────────`);
    console.log(`  Local:    http://localhost:${PORT}`);
    console.log(`  Pass DL:  http://localhost:${PORT}/pass`);
    console.log(`  Web URL:  ${process.env.WEB_SERVICE_URL || "(not configured)"}`);
    console.log();
});
