'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { buildApp } = require('../server.js');

const API_KEY = 'integration-layer-b-key';

test('Layer-B cache flow (integration, isolated temp dirs)', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-tts-layer-b-int-'));
    const dbDir = path.join(root, 'database');
    const cacheDir = path.join(root, 'audio_cache');

    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const app = buildApp({
        apiKey: API_KEY,
        dbDir,
        cacheDir,
        skipBackgroundTimers: true,
        cacheThreshold: 2,
        debugLog: false,
    });

    const payload = { text: 'cache-flow', speakerId: 1, speed: 1.0, pitch: 0.0 };
    const auth = { Authorization: `Bearer ${API_KEY}` };

    const miss1 = await request(app).post('/cache/search').set(auth).send(payload);
    assert.strictEqual(miss1.status, 404);
    assert.strictEqual(miss1.body.shouldCache, false);

    const miss2 = await request(app).post('/cache/search').set(auth).send(payload);
    assert.strictEqual(miss2.status, 404);
    assert.strictEqual(miss2.body.shouldCache, true);

    const wavBytes = Buffer.from('RIFFfake-wav', 'utf8');
    const save = await request(app)
        .post('/cache/save')
        .set(auth)
        .send({
            ...payload,
            audioBase64: wavBytes.toString('base64'),
        });
    assert.strictEqual(save.status, 200);
    assert.strictEqual(save.body.success, true);

    const hit = await request(app).post('/cache/search').set(auth).send(payload);
    assert.strictEqual(hit.status, 200);
    assert.strictEqual(hit.headers['content-type'], 'audio/wav');
    assert.ok(Buffer.isBuffer(hit.body));
    assert.deepStrictEqual(hit.body, wavBytes);
});
