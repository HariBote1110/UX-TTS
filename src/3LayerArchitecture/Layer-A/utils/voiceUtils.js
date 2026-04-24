const { VoiceConnectionStatus } = require('@discordjs/voice');

/**
 * Safely destroys a Discord voice connection, handling errors and null checks.
 * @param {import('@discordjs/voice').VoiceConnection} connection - The voice connection to destroy.
 * @returns {boolean} True if destroy() was successfully called, false otherwise.
 */
function safeDestroy(connection) {
    if (!connection) return false;

    // Check if the connection has a state and if it is already destroyed
    if (connection.state && connection.state.status === VoiceConnectionStatus.Destroyed) {
        return false;
    }

    try {
        connection.destroy();
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = { safeDestroy };
