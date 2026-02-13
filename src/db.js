/**
 * SQLite database for Apple Wallet device registrations.
 * Follows Apple's recommended schema:
 *   - devices: stores device library identifiers and push tokens
 *   - passes: stores pass serial numbers and last-update timestamps
 *   - registrations: many-to-many between devices and passes
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.resolve(__dirname, "..", "data", "wallet.db");

let db;

function getDb() {
    if (!db) {
        // Ensure data directory exists
        const fs = require("fs");
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        db = new Database(DB_PATH);
        db.pragma("journal_mode = WAL");

        // Create tables if they don't exist
        db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_library_identifier TEXT UNIQUE NOT NULL,
        push_token TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS passes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pass_type_identifier TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        authentication_token TEXT NOT NULL,
        last_updated INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(pass_type_identifier, serial_number)
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        pass_id INTEGER NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
        UNIQUE(device_id, pass_id)
      );
    `);
    }
    return db;
}

// ─── Device operations ───────────────────────────────────────────────

function findOrCreateDevice(deviceLibraryIdentifier, pushToken) {
    const d = getDb();
    const existing = d
        .prepare("SELECT * FROM devices WHERE device_library_identifier = ?")
        .get(deviceLibraryIdentifier);

    if (existing) {
        // Update push token if changed
        if (existing.push_token !== pushToken) {
            d.prepare("UPDATE devices SET push_token = ? WHERE id = ?").run(
                pushToken,
                existing.id
            );
        }
        return { ...existing, isNew: false };
    }

    const result = d
        .prepare(
            "INSERT INTO devices (device_library_identifier, push_token) VALUES (?, ?)"
        )
        .run(deviceLibraryIdentifier, pushToken);
    return {
        id: result.lastInsertRowid,
        device_library_identifier: deviceLibraryIdentifier,
        push_token: pushToken,
        isNew: true,
    };
}

function findDevice(deviceLibraryIdentifier) {
    return getDb()
        .prepare("SELECT * FROM devices WHERE device_library_identifier = ?")
        .get(deviceLibraryIdentifier);
}

function deleteDevice(deviceId) {
    getDb().prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
}

// ─── Pass operations ─────────────────────────────────────────────────

function findOrCreatePass(passTypeIdentifier, serialNumber, authToken) {
    const d = getDb();
    const existing = d
        .prepare(
            "SELECT * FROM passes WHERE pass_type_identifier = ? AND serial_number = ?"
        )
        .get(passTypeIdentifier, serialNumber);

    if (existing) {
        return { ...existing, isNew: false };
    }

    const result = d
        .prepare(
            "INSERT INTO passes (pass_type_identifier, serial_number, authentication_token) VALUES (?, ?, ?)"
        )
        .run(passTypeIdentifier, serialNumber, authToken);
    return {
        id: result.lastInsertRowid,
        pass_type_identifier: passTypeIdentifier,
        serial_number: serialNumber,
        authentication_token: authToken,
        isNew: true,
    };
}

function touchPass(passTypeIdentifier, serialNumber) {
    getDb()
        .prepare(
            "UPDATE passes SET last_updated = strftime('%s','now') WHERE pass_type_identifier = ? AND serial_number = ?"
        )
        .run(passTypeIdentifier, serialNumber);
}

// ─── Registration operations ─────────────────────────────────────────

function findOrCreateRegistration(deviceId, passId) {
    const d = getDb();
    const existing = d
        .prepare(
            "SELECT * FROM registrations WHERE device_id = ? AND pass_id = ?"
        )
        .get(deviceId, passId);

    if (existing) {
        return { ...existing, isNew: false };
    }

    const result = d
        .prepare("INSERT INTO registrations (device_id, pass_id) VALUES (?, ?)")
        .run(deviceId, passId);
    return { id: result.lastInsertRowid, isNew: true };
}

function deleteRegistration(deviceLibraryIdentifier, serialNumber) {
    const d = getDb();
    const row = d
        .prepare(
            `SELECT r.id FROM registrations r
       JOIN devices d ON r.device_id = d.id
       JOIN passes p ON r.pass_id = p.id
       WHERE d.device_library_identifier = ? AND p.serial_number = ?`
        )
        .get(deviceLibraryIdentifier, serialNumber);

    if (row) {
        d.prepare("DELETE FROM registrations WHERE id = ?").run(row.id);
        return true;
    }
    return false;
}

/**
 * Get serial numbers of passes registered to a device, optionally
 * filtered by passesUpdatedSince.
 */
function getPassesForDevice(
    deviceLibraryIdentifier,
    passTypeIdentifier,
    passesUpdatedSince
) {
    const d = getDb();
    let query = `
    SELECT p.serial_number, p.last_updated
    FROM passes p
    JOIN registrations r ON r.pass_id = p.id
    JOIN devices d ON r.device_id = d.id
    WHERE d.device_library_identifier = ?
      AND p.pass_type_identifier = ?
  `;
    const params = [deviceLibraryIdentifier, passTypeIdentifier];

    if (passesUpdatedSince) {
        query += " AND p.last_updated > ?";
        params.push(passesUpdatedSince);
    }

    return d.prepare(query).all(...params);
}

/**
 * Get all push tokens for devices registered to a given pass.
 */
function getPushTokensForPass(passTypeIdentifier, serialNumber) {
    return getDb()
        .prepare(
            `SELECT d.push_token FROM devices d
       JOIN registrations r ON r.device_id = d.id
       JOIN passes p ON r.pass_id = p.id
       WHERE p.pass_type_identifier = ? AND p.serial_number = ?`
        )
        .all(passTypeIdentifier, serialNumber)
        .map((row) => row.push_token);
}

module.exports = {
    findOrCreateDevice,
    findDevice,
    deleteDevice,
    findOrCreatePass,
    touchPass,
    findOrCreateRegistration,
    deleteRegistration,
    getPassesForDevice,
    getPushTokensForPass,
};
