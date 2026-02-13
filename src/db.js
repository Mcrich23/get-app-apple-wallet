/**
 * SQLite database for tracking Apple Wallet registrations.
 * Stores devices, passes, and their registrations.
 */

const Database = require("better-sqlite3");
const path = require("path");

// Create database in project root
const dbPath = path.resolve(__dirname, "..", "wallet.db");
const db = new Database(dbPath);

// Enable foreign keys
db.pragma("foreign_keys = ON");

// ─── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_library_id TEXT UNIQUE NOT NULL,
    push_token TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pass_type_id TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    authentication_token TEXT NOT NULL,
    last_updated INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(pass_type_id, serial_number)
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    pass_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(device_id, pass_id),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (pass_id) REFERENCES passes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_devices_library_id ON devices(device_library_id);
  CREATE INDEX IF NOT EXISTS idx_passes_serial ON passes(serial_number);
  CREATE INDEX IF NOT EXISTS idx_registrations_device ON registrations(device_id);
  CREATE INDEX IF NOT EXISTS idx_registrations_pass ON registrations(pass_id);
`);

console.log(`📦 Database initialized: ${dbPath}`);

// ─── Prepared Statements ─────────────────────────────────────────────

const stmts = {
    findDevice: db.prepare(
        "SELECT * FROM devices WHERE device_library_id = ?"
    ),
    insertDevice: db.prepare(
        "INSERT INTO devices (device_library_id, push_token) VALUES (?, ?)"
    ),
    updateDevicePushToken: db.prepare(
        "UPDATE devices SET push_token = ? WHERE id = ?"
    ),
    deleteDevice: db.prepare("DELETE FROM devices WHERE id = ?"),

    findPass: db.prepare(
        "SELECT * FROM passes WHERE pass_type_id = ? AND serial_number = ?"
    ),
    insertPass: db.prepare(
        "INSERT INTO passes (pass_type_id, serial_number, authentication_token) VALUES (?, ?, ?)"
    ),
    touchPass: db.prepare(
        "UPDATE passes SET last_updated = strftime('%s', 'now') WHERE pass_type_id = ? AND serial_number = ?"
    ),

    findRegistration: db.prepare(
        "SELECT * FROM registrations WHERE device_id = ? AND pass_id = ?"
    ),
    insertRegistration: db.prepare(
        "INSERT INTO registrations (device_id, pass_id) VALUES (?, ?)"
    ),
    deleteRegistration: db.prepare(
        `DELETE FROM registrations 
         WHERE device_id = (SELECT id FROM devices WHERE device_library_id = ?)
         AND pass_id = (SELECT id FROM passes WHERE serial_number = ?)`
    ),

    getPassesForDevice: db.prepare(`
        SELECT p.serial_number, p.last_updated
        FROM passes p
        JOIN registrations r ON r.pass_id = p.id
        JOIN devices d ON d.id = r.device_id
        WHERE d.device_library_id = ? AND p.pass_type_id = ?
        AND (? IS NULL OR p.last_updated > ?)
    `),
};

// ─── API Functions ───────────────────────────────────────────────────

/**
 * Find or create a device.
 * @returns {object} device row with { id, device_library_id, push_token, isNew }
 */
function findOrCreateDevice(deviceLibraryId, pushToken) {
    let device = stmts.findDevice.get(deviceLibraryId);

    if (device) {
        // Update push token if it changed
        if (device.push_token !== pushToken) {
            stmts.updateDevicePushToken.run(pushToken, device.id);
            device.push_token = pushToken;
        }
        return { ...device, isNew: false };
    }

    const info = stmts.insertDevice.run(deviceLibraryId, pushToken);
    return {
        id: info.lastInsertRowid,
        device_library_id: deviceLibraryId,
        push_token: pushToken,
        isNew: true,
    };
}

/**
 * Find or create a pass.
 * @returns {object} pass row with { id, pass_type_id, serial_number, authentication_token, isNew }
 */
function findOrCreatePass(passTypeId, serialNumber, authenticationToken) {
    let pass = stmts.findPass.get(passTypeId, serialNumber);

    if (pass) {
        return { ...pass, isNew: false };
    }

    const info = stmts.insertPass.run(
        passTypeId,
        serialNumber,
        authenticationToken
    );
    return {
        id: info.lastInsertRowid,
        pass_type_id: passTypeId,
        serial_number: serialNumber,
        authentication_token: authenticationToken,
        isNew: true,
    };
}

/**
 * Find or create a registration.
 * @returns {object} registration row with { id, device_id, pass_id, isNew }
 */
function findOrCreateRegistration(deviceId, passId) {
    let registration = stmts.findRegistration.get(deviceId, passId);

    if (registration) {
        return { ...registration, isNew: false };
    }

    const info = stmts.insertRegistration.run(deviceId, passId);
    return {
        id: info.lastInsertRowid,
        device_id: deviceId,
        pass_id: passId,
        isNew: true,
    };
}

/**
 * Update the last_updated timestamp for a pass.
 */
function touchPass(passTypeId, serialNumber) {
    stmts.touchPass.run(passTypeId, serialNumber);
}

/**
 * Get all passes registered for a device.
 * @param {string} deviceLibraryId
 * @param {string} passTypeId
 * @param {string|null} passesUpdatedSince - epoch seconds
 * @returns {Array} array of { serial_number, last_updated }
 */
function getPassesForDevice(deviceLibraryId, passTypeId, passesUpdatedSince) {
    const since = passesUpdatedSince ? parseInt(passesUpdatedSince, 10) : null;
    return stmts.getPassesForDevice.all(
        deviceLibraryId,
        passTypeId,
        since,
        since
    );
}

/**
 * Delete a registration.
 * @returns {boolean} true if deleted, false if not found
 */
function deleteRegistration(deviceLibraryId, serialNumber) {
    const info = stmts.deleteRegistration.run(deviceLibraryId, serialNumber);
    return info.changes > 0;
}

/**
 * Find a device by library ID.
 */
function findDevice(deviceLibraryId) {
    return stmts.findDevice.get(deviceLibraryId);
}

/**
 * Delete a device by ID.
 */
function deleteDevice(deviceId) {
    stmts.deleteDevice.run(deviceId);
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
    db,
    findOrCreateDevice,
    findOrCreatePass,
    findOrCreateRegistration,
    touchPass,
    getPassesForDevice,
    deleteRegistration,
    findDevice,
    deleteDevice,
};
