const test = require('node:test');
const assert = require('node:assert');
const {
    notifyCharLimitExceeded,
    COOLDOWN_MS,
    __resetLimitNotifyStateForTests,
} = require('../utils/limitExceededNotifier');

test('limitExceededNotifier', async (t) => {
    await t.test('sends one embed to the text channel when limit applies', async () => {
        __resetLimitNotifyStateForTests();
        const sends = [];
        const ch = {
            isTextBased: () => true,
            send: async (payload) => {
                sends.push(payload);
            },
        };
        const client = {
            channels: {
                cache: {
                    get: (id) => (id === 'ch1' ? ch : null),
                },
            },
        };

        await notifyCharLimitExceeded(client, 'ch1', 'g1', { now: 10_000 });

        assert.strictEqual(sends.length, 1);
        assert.ok(sends[0].embeds?.[0]);
        assert.strictEqual(sends[0].embeds[0].data.title, '⚠️ 読み上げ制限');
        assert.match(sends[0].embeds[0].data.description, /上限に達している/);
    });

    await t.test('does not send again within cooldown for the same guild', async () => {
        __resetLimitNotifyStateForTests();
        const sends = [];
        const ch = {
            isTextBased: () => true,
            send: async (payload) => {
                sends.push(payload);
            },
        };
        const client = {
            channels: {
                cache: {
                    get: (id) => (id === 'ch1' ? ch : null),
                },
            },
        };

        await notifyCharLimitExceeded(client, 'ch1', 'g1', { now: 0 });
        await notifyCharLimitExceeded(client, 'ch1', 'g1', { now: COOLDOWN_MS - 1 });

        assert.strictEqual(sends.length, 1);
    });

    await t.test('sends again after cooldown elapses', async () => {
        __resetLimitNotifyStateForTests();
        const sends = [];
        const ch = {
            isTextBased: () => true,
            send: async (payload) => {
                sends.push(payload);
            },
        };
        const client = {
            channels: {
                cache: {
                    get: (id) => (id === 'ch1' ? ch : null),
                },
            },
        };

        await notifyCharLimitExceeded(client, 'ch1', 'g1', { now: 0 });
        await notifyCharLimitExceeded(client, 'ch1', 'g1', { now: COOLDOWN_MS });

        assert.strictEqual(sends.length, 2);
    });

    await t.test('no-op when channelId is missing', async () => {
        __resetLimitNotifyStateForTests();
        const client = { channels: { cache: { get: () => assert.fail('should not resolve channel') } } };
        await notifyCharLimitExceeded(client, null, 'g1', { now: 0 });
    });
});
