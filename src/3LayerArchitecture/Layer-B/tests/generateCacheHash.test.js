'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateCacheHash } = require('../lib/generateCacheHash.js');

test('generateCacheHash', async (t) => {
    await t.test('returns stable MD5 hex for parameter tuple', () => {
        const digest = generateCacheHash('test', 2, 1.5, 0.5);
        assert.strictEqual(digest, 'b5b6f73e2b8b95790b8511a7e3cd0690');
    });

    await t.test('changes when any input changes', () => {
        const a = generateCacheHash('hello', 1, 1, 0);
        const b = generateCacheHash('hello', 1, 1, 0.1);
        assert.notStrictEqual(a, b);
    });
});
