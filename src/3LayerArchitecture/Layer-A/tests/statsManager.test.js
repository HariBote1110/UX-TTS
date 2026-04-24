const test = require('node:test');
const assert = require('node:assert');
const statsManager = require('../utils/statsManager');

test('statsManager - incrementRequest', async (t) => {
    // Reset state before tests
    statsManager.getAndResetStats();

    await t.test('should increment totalRequests and ojtRequests when isOjt is true', () => {
        statsManager.incrementRequest(true);
        const stats = statsManager.getAndResetStats();

        assert.strictEqual(stats.totalRequests, 1, 'totalRequests should be 1');
        assert.strictEqual(stats.ojtRequests, 1, 'ojtRequests should be 1');
        assert.strictEqual(stats.voicevoxRequests, 0, 'voicevoxRequests should be 0');
    });

    await t.test('should increment totalRequests and voicevoxRequests when isOjt is false', () => {
        statsManager.incrementRequest(false);
        const stats = statsManager.getAndResetStats();

        assert.strictEqual(stats.totalRequests, 1, 'totalRequests should be 1');
        assert.strictEqual(stats.ojtRequests, 0, 'ojtRequests should be 0');
        assert.strictEqual(stats.voicevoxRequests, 1, 'voicevoxRequests should be 1');
    });

    await t.test('should accumulate multiple requests correctly', () => {
        statsManager.incrementRequest(true);
        statsManager.incrementRequest(false);
        statsManager.incrementRequest(true);

        const stats = statsManager.getAndResetStats();

        assert.strictEqual(stats.totalRequests, 3, 'totalRequests should be 3');
        assert.strictEqual(stats.ojtRequests, 2, 'ojtRequests should be 2');
        assert.strictEqual(stats.voicevoxRequests, 1, 'voicevoxRequests should be 1');
    });

    await t.test('should maintain state until reset', () => {
        statsManager.incrementRequest(true);

        // This is where we might check some intermediate state, but getAndResetStats resets it.
        // We'll increment again to check accumulation
        statsManager.incrementRequest(false);

        const stats = statsManager.getAndResetStats();

        assert.strictEqual(stats.totalRequests, 2);
        assert.strictEqual(stats.ojtRequests, 1);
        assert.strictEqual(stats.voicevoxRequests, 1);

        // Check state after reset
        const resetStats = statsManager.getAndResetStats();
        assert.strictEqual(resetStats.totalRequests, 0);
        assert.strictEqual(resetStats.ojtRequests, 0);
        assert.strictEqual(resetStats.voicevoxRequests, 0);
    });
});
