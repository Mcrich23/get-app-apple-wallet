/**
 * Client for the Cbord GET Services API.
 * Mirrors the patterns from get-tools-main/src/getStore.ts.
 */

const ENDPOINT = "https://services.get.cbord.com/GETServices/services/json";

/**
 * Low-level request to GET API.
 * @param {string} service - e.g. "authentication", "commerce"
 * @param {string} method  - e.g. "authenticatePIN"
 * @param {object} params
 * @returns {Promise<any>}
 */
async function makeGETRequest(service, method, params = {}) {
    const res = await fetch(`${ENDPOINT}/${service}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({ method, params }),
    });
    return res.json();
}

/**
 * Register a new deviceId + PIN pair with an existing session.
 * This mirrors the pattern in get-tools-main/src/onboarding/Onboarding.svelte.
 * @param {string} sessionId - existing authenticated session
 * @param {string} deviceId  - randomly generated device ID
 * @param {string} pin       - randomly generated PIN
 * @returns {Promise<boolean>} true if successful
 */
async function createPIN(sessionId, deviceId, pin) {
    const { response, exception } = await makeGETRequest(
        "user",
        "createPIN",
        {
            sessionId,
            deviceId,
            PIN: pin,
        }
    );

    if (exception) {
        throw new Error(`GET createPIN failed: ${JSON.stringify(exception)}`);
    }
    if (response !== true) {
        throw new Error("createPIN returned unexpected response");
    }
    return true;
}

/**
 * Generate a random deviceId and PIN, matching get-tools-main.
 * @returns {{ deviceId: string, pin: string }}
 */
function generateCredentials() {
    const deviceId = Math.round(Math.random() * 100_000_000_000_000_000)
        .toString(16)
        .padStart(16, "9");
    const pin = Math.floor(Math.random() * 9999)
        .toString()
        .padStart(4, "0");
    return { deviceId, pin };
}

/**
 * Authenticate with PIN + deviceId and return a sessionId.
 * @param {string} pin
 * @param {string} deviceId
 * @returns {Promise<string>} sessionId
 */
async function authenticatePIN(pin, deviceId) {
    const { response, exception } = await makeGETRequest(
        "authentication",
        "authenticatePIN",
        {
            pin,
            deviceId,
            systemCredentials: {
                password: "NOTUSED",
                userName: "get_mobile",
                domain: "",
            },
        }
    );

    if (exception) {
        throw new Error(`GET auth failed: ${JSON.stringify(exception)}`);
    }
    return response; // sessionId string
}

/**
 * Retrieve the patron barcode payload (the string rendered as PDF417).
 * @param {string} sessionId
 * @returns {Promise<string>} barcode payload
 */
async function retrieveBarcode(sessionId) {
    const { response, exception } = await makeGETRequest(
        "authentication",
        "retrievePatronBarcodePayload",
        { sessionId }
    );
    if (exception) {
        throw new Error(`GET barcode failed: ${JSON.stringify(exception)}`);
    }
    return response;
}

/**
 * Retrieve account balances.
 * @param {string} sessionId
 * @returns {Promise<Array<{accountDisplayName:string, balance:number, isActive:boolean, isAccountTenderActive:boolean}>>}
 */
async function retrieveAccounts(sessionId) {
    const { response, exception } = await makeGETRequest(
        "commerce",
        "retrieveAccounts",
        { sessionId }
    );
    if (exception) {
        throw new Error(`GET accounts failed: ${JSON.stringify(exception)}`);
    }
    return response.accounts || [];
}

export { createPIN, generateCredentials, authenticatePIN, retrieveBarcode, retrieveAccounts };
