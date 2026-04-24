const test = require('node:test');
const assert = require('node:assert');

const { normalizeText } = require('../utils/easterEggManager.js');

test('normalizeText', async (t) => {
    await t.test('returns empty string for falsy input', () => {
        assert.strictEqual(normalizeText(''), '');
        assert.strictEqual(normalizeText(null), '');
        assert.strictEqual(normalizeText(undefined), '');
    });

    await t.test('applies NFC normalisation', () => {
        const composed = 'e\u0301';
        const out = normalizeText(composed);
        assert.strictEqual(out, 'é');
    });

    await t.test('replaces wave dash U+301C with fullwidth tilde U+FF5E', () => {
        assert.strictEqual(normalizeText('a\u301Cb'), 'a\uFF5Eb');
    });
});
