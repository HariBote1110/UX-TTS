const test = require('node:test');
const assert = require('node:assert');

const { WorkerConfig } = require('../utils/workerConfig.js');

test('WorkerConfig', async (t) => {
    const prev = process.env.WORKER_CONFIG;

    t.afterEach(() => {
        if (prev === undefined) {
            delete process.env.WORKER_CONFIG;
        } else {
            process.env.WORKER_CONFIG = prev;
        }
    });

    await t.test('uses default weight and capacity when env is unset', () => {
        delete process.env.WORKER_CONFIG;
        const wc = new WorkerConfig();
        assert.strictEqual(wc.getWeight('http://any'), 1.0);
        assert.strictEqual(wc.getCapacity('http://any'), Infinity);
    });

    await t.test('parses WORKER_CONFIG JSON', () => {
        process.env.WORKER_CONFIG = JSON.stringify({
            'http://worker-a': { weight: 2.5, capacity: 3 }
        });
        const wc = new WorkerConfig();
        assert.strictEqual(wc.getWeight('http://worker-a'), 2.5);
        assert.strictEqual(wc.getCapacity('http://worker-a'), 3);
    });

    await t.test('reload clears and reapplies config', () => {
        process.env.WORKER_CONFIG = JSON.stringify({
            'http://one': { weight: 1, capacity: 1 }
        });
        const wc = new WorkerConfig();
        assert.strictEqual(wc.getWeight('http://one'), 1);

        process.env.WORKER_CONFIG = JSON.stringify({
            'http://two': { weight: 4, capacity: 2 }
        });
        wc.reload();
        assert.strictEqual(wc.getWeight('http://one'), 1.0);
        assert.strictEqual(wc.getWeight('http://two'), 4);
        assert.strictEqual(wc.getCapacity('http://two'), 2);
    });
});
