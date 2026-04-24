'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseLayerDBaseUrls } = require('../lib/parseLayerDBaseUrls.js');

test('parseLayerDBaseUrls', async (t) => {
    await t.test('splits comma-separated URLs and trims whitespace', () => {
        const urls = parseLayerDBaseUrls('http://a:1 , http://b:2 ');
        assert.deepStrictEqual(urls, ['http://a:1', 'http://b:2']);
    });

    await t.test('falls back to default when only whitespace or empty segments', () => {
        assert.deepStrictEqual(parseLayerDBaseUrls('   '), []);
        assert.deepStrictEqual(parseLayerDBaseUrls(' , , '), []);
    });

    await t.test('keeps single URL without commas', () => {
        assert.deepStrictEqual(parseLayerDBaseUrls('http://localhost:5502'), ['http://localhost:5502']);
    });
});
