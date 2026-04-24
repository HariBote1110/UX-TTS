'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeSynthesisText } = require('../lib/sanitizeSynthesisText.js');

test('sanitizeSynthesisText', async (t) => {
    await t.test('trims and keeps plain Japanese', () => {
        const r = sanitizeSynthesisText('  こんにちは  ', false);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.text, 'こんにちは');
    });

    await t.test('removes lone high surrogate', () => {
        const r = sanitizeSynthesisText('a\uD800b', false);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.text, 'ab');
    });

    await t.test('removes lone low surrogate', () => {
        const r = sanitizeSynthesisText('a\uDC00b', false);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.text, 'ab');
    });

    await t.test('preserves valid surrogate pair', () => {
        const grinning = '\uD83D\uDE00';
        const r = sanitizeSynthesisText(`hello${grinning}`, false);
        assert.strictEqual(r.ok, true);
        assert.ok(r.text.includes(grinning));
    });

    await t.test('returns empty_after when only whitespace', () => {
        const r = sanitizeSynthesisText('   \t\n  ', false);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'empty_after_sanitisation');
    });

    await t.test('with useOjt strips supplementary-plane characters', () => {
        const r = sanitizeSynthesisText('あ\u{1F600}い', true);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.text, 'あい');
    });
});
