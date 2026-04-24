const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;

function loadDictionaryProcessorWithDbMock(mockDb) {
    const resolved = require.resolve('../utils/dictionaryProcessor.js');
    delete require.cache[resolved];

    Module._load = function(request, parent, isMain) {
        const base = path.basename(String(request));
        if (base === 'database.js' || base === 'database') {
            return mockDb;
        }
        return originalLoad.apply(this, arguments);
    };

    try {
        return require('../utils/dictionaryProcessor.js');
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolved];
    }
}

test.after(() => {
    Module._load = originalLoad;
});

test('applyAdvancedDictionaryWithDict', async (t) => {
    const { applyAdvancedDictionaryWithDict } = loadDictionaryProcessorWithDbMock({
        getDictionaryEntries: async () => [],
        getUserPersonalDictionaryEntries: async () => []
    });

    await t.test('returns original text when dict is empty', () => {
        assert.strictEqual(applyAdvancedDictionaryWithDict('hello', []), 'hello');
        assert.strictEqual(applyAdvancedDictionaryWithDict('hello', null), 'hello');
    });

    await t.test('replaces pattern with default when no keyword rules match', () => {
        const dict = [{ pattern: 'foo', default: 'bar', rules: [] }];
        assert.strictEqual(applyAdvancedDictionaryWithDict('a foo b', dict), 'a bar b');
    });

    await t.test('uses rule read when local context contains a keyword', () => {
        const dict = [{
            pattern: '空いている',
            default: 'あいている',
            rules: [{ keywords: ['電車'], read: 'すいている' }]
        }];
        assert.strictEqual(
            applyAdvancedDictionaryWithDict('電車が空いている', dict),
            '電車がすいている'
        );
    });

    await t.test('applies different reads per occurrence based on local context', () => {
        const dict = [{
            pattern: '空いている',
            default: 'あいている',
            rules: [{ keywords: ['電車'], read: 'すいている' }]
        }];
        const input = '電車が空いている。店が空いている。';
        const out = applyAdvancedDictionaryWithDict(input, dict);
        assert.strictEqual(out, '電車がすいている。店があいている。');
    });
});

test('replaceSlang', async (t) => {
    await t.test('merges guild then personal entries; personal overrides same word', async () => {
        const { replaceSlang } = loadDictionaryProcessorWithDbMock({
            getDictionaryEntries: async () => [
                { word: 'foo', read_as: 'guild' },
                { word: 'shared', read_as: 'from_guild' }
            ],
            getUserPersonalDictionaryEntries: async () => [
                { word: 'foo', read_as: 'personal' }
            ]
        });

        const out = await replaceSlang('g1', 'u1', 'foo and shared');
        assert.strictEqual(out, 'personal and from_guild');
    });

    await t.test('returns text unchanged when no dictionary rows', async () => {
        const { replaceSlang } = loadDictionaryProcessorWithDbMock({
            getDictionaryEntries: async () => [],
            getUserPersonalDictionaryEntries: async () => []
        });

        const plain = 'no-dict-tokens-xyz-12345';
        const out = await replaceSlang('g1', 'u1', plain);
        assert.strictEqual(out, plain);
    });

    await t.test('skips personal fetch when authorUserId is falsy', async () => {
        let personalCalled = false;
        const { replaceSlang } = loadDictionaryProcessorWithDbMock({
            getDictionaryEntries: async () => [{ word: 'w', read_as: 'x' }],
            getUserPersonalDictionaryEntries: async () => {
                personalCalled = true;
                return [];
            }
        });

        const out = await replaceSlang('g1', null, 'w');
        assert.strictEqual(out, 'x');
        assert.strictEqual(personalCalled, false);
    });
});
