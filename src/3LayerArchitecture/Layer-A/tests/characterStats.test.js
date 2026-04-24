const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CharacterStats } = require('../utils/characterStats.js');

test('CharacterStats (isolated file)', async (t) => {
    let statsFile;

    t.beforeEach(() => {
        statsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-')), 'usage.json');
    });

    t.afterEach(() => {
        try {
            fs.unlinkSync(statsFile);
            fs.rmdirSync(path.dirname(statsFile));
        } catch {
            /* ignore */
        }
    });

    await t.test('isHighUsage is false before any top-three ranking', () => {
        const cs = new CharacterStats({ statsFile });
        assert.strictEqual(cs.isHighUsage(1), false);
    });

    await t.test('isHighUsage becomes true for speaker in top 3 by count', () => {
        const cs = new CharacterStats({ statsFile });
        for (let i = 0; i < 30; i++) cs.recordUsage(10);
        for (let i = 0; i < 20; i++) cs.recordUsage(20);
        for (let i = 0; i < 10; i++) cs.recordUsage(30);
        cs.updateTopCharacters();

        assert.strictEqual(cs.isHighUsage(10), true);
        assert.strictEqual(cs.isHighUsage(20), true);
        assert.strictEqual(cs.isHighUsage(30), true);
        assert.strictEqual(cs.isHighUsage(99), false);
    });

    await t.test('recordUsage ignores falsy speakerId except 0', () => {
        const cs = new CharacterStats({ statsFile });
        cs.recordUsage(null);
        cs.recordUsage('');
        assert.deepStrictEqual(cs.getStats(), {});
        cs.recordUsage(0);
        assert.strictEqual(cs.getStats()['0'], 1);
    });
});
