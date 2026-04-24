'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const request = require('supertest');

const originalLoad = Module._load;

function isAxiosModule(requestPath) {
    const s = String(requestPath);
    if (s === 'axios') return true;
    const n = s.replace(/\\/g, '/');
    return n.includes('/node_modules/axios/');
}

function installAxiosStub() {
    Module._load = function(requestPath, parent, isMain) {
        if (isAxiosModule(requestPath)) {
            return {
                get: async (targetUrl) => {
                    if (String(targetUrl).includes('/version')) {
                        return { data: { status: 'ok' } };
                    }
                    return { data: {} };
                },
                post: async (targetUrl) => {
                    const u = String(targetUrl);
                    if (u.includes('audio_query')) {
                        return { data: { accent_phrases: [], speedScale: 1, pitchScale: 0, volumeScale: 1 } };
                    }
                    if (u.includes('synthesis')) {
                        return {
                            data: Buffer.from([0x52, 0x49, 0x46, 0x46]),
                            headers: { 'content-type': 'audio/wav' }
                        };
                    }
                    return { data: Buffer.alloc(0), headers: { 'content-type': 'application/octet-stream' } };
                }
            };
        }
        return originalLoad.apply(this, arguments);
    };
}

function loadBuildApp() {
    const resolved = require.resolve('../server.js');
    delete require.cache[resolved];
    try {
        delete require.cache[require.resolve('axios')];
    } catch {
        /* ignore */
    }
    return require('../server.js').buildApp;
}

test.after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../server.js')];
});

test('Layer-C HTTP (buildApp + supertest)', async (t) => {
    await t.test('GET /version without auth returns payload', async () => {
        installAxiosStub();
        const buildApp = loadBuildApp();
        const app = buildApp({ apiKey: 'http-test-key', skipStatsPersistence: true });
        const res = await request(app).get('/version').expect(200);
        assert.strictEqual(res.body.status, 'ok');
        assert.strictEqual(res.body.version, '1.2.0-Beta-1e');
    });

    await t.test('POST /synthesize without Bearer returns 401', async () => {
        installAxiosStub();
        const buildApp = loadBuildApp();
        const app = buildApp({ apiKey: 'http-test-key', skipStatsPersistence: true });
        await request(app)
            .post('/synthesize')
            .send({ text: 'hello' })
            .expect(401);
    });

    await t.test('POST /synthesize with auth returns audio (mocked upstream)', async () => {
        installAxiosStub();
        const buildApp = loadBuildApp();
        const app = buildApp({
            apiKey: 'secret',
            voicelabsUrl: 'http://vv.test',
            skipStatsPersistence: true
        });
        await request(app)
            .post('/synthesize')
            .set('Authorization', 'Bearer secret')
            .send({ text: 'こんにちは', speakerId: 1 })
            .expect(200)
            .expect('Content-Type', /audio/);
    });

    await t.test('POST /synthesize rejects empty text', async () => {
        installAxiosStub();
        const buildApp = loadBuildApp();
        const app = buildApp({ apiKey: 'secret', skipStatsPersistence: true });
        const res = await request(app)
            .post('/synthesize')
            .set('Authorization', 'Bearer secret')
            .send({ text: '' })
            .expect(400);
        assert.strictEqual(res.body.error, 'Text is required');
    });
});
