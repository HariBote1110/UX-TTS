const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;

function mockedLoad(request, parent, isMain) {
    const req = String(request);
    const base = path.basename(req);

    if (base === 'discord.js') {
        class EmbedBuilder {
            constructor() {
                this.data = {};
            }
            setColor(colour) {
                this.data.color = colour;
                return this;
            }
            setDescription(description) {
                this.data.description = description;
                return this;
            }
            setTitle(title) {
                this.data.title = title;
                return this;
            }
        }
        return {
            EmbedBuilder,
            ActivityType: {},
            ActionRowBuilder: class {},
            StringSelectMenuBuilder: class {},
            UserSelectMenuBuilder: class {},
            ButtonBuilder: class {},
            ButtonStyle: {},
            MessageFlags: {},
            PermissionsBitField: { Flags: {} }
        };
    }
    if (base === 'database.js' || base === 'database') {
        return {
            getAllGuildUsage: () => [],
            resetGuildUsage: () => {},
            getCurrentMonth: () => '2023-10',
            getUserSettings: () => ({}),
            getGuildSettings: () => ({}),
            getIgnoreChannels: () => [],
            getAllowChannels: () => [],
            getAllChannelPairs: () => [],
            getAutoVCGenerators: () => []
        };
    }
    if (base === 'audioCache.js') {
        return { sweepCache: () => {} };
    }
    if (base === 'errorLogger.js') {
        return { sendErrorLog: () => {} };
    }
    if (base === 'statsManager.js') {
        return { getAverageLatencyStats: () => ({ avg: 0, min: 0, max: 0, count: 0 }) };
    }
    return originalLoad.apply(this, arguments);
}

Module._load = mockedLoad;

const { createStatusEmbed, createStatusMessage } = require('../utils/helpers.js');
const { EmbedBuilder } = require('discord.js');

test.after(() => {
    Module._load = originalLoad;
});

// Root-level tests in a file run concurrently; keep embed tests in one suite so discord.js mock + helpers stay consistent.
test('helpers — status embed and message', async (t) => {
    await t.test('createStatusEmbed: creates an info embed by default', () => {
        const embed = createStatusEmbed();
        assert.strictEqual(embed.data.color, 0x00AAFF);
        assert.strictEqual(embed.data.description, '');
        assert.strictEqual(embed.data.title, 'ℹ️ お知らせ');
    });

    await t.test('creates a success embed', () => {
        const embed = createStatusEmbed('success', 'Operation successful');
        assert.strictEqual(embed.data.color, 0x57F287);
        assert.strictEqual(embed.data.description, 'Operation successful');
        assert.strictEqual(embed.data.title, '✅ 成功');
    });

    await t.test('uses default info for unknown type', () => {
        const embed = createStatusEmbed('unknown_type', 'Some text');
        assert.strictEqual(embed.data.color, 0x00AAFF);
        assert.strictEqual(embed.data.description, 'Some text');
        assert.strictEqual(embed.data.title, 'ℹ️ お知らせ');
    });

    await t.test('overrides title if provided', () => {
        const embed = createStatusEmbed('warning', 'Be careful', 'Custom Warning');
        assert.strictEqual(embed.data.color, 0xFEE75C);
        assert.strictEqual(embed.data.description, 'Be careful');
        assert.strictEqual(embed.data.title, 'Custom Warning');
    });

    await t.test('createStatusEmbed: handles falsy description and custom title correctly', () => {
        const embed = createStatusEmbed('error', null, 'My Error');
        assert.strictEqual(embed.data.color, 0xED4245);
        assert.strictEqual(embed.data.description, '');
        assert.strictEqual(embed.data.title, 'My Error');
    });

    await t.test('createStatusMessage: creates basic status message with info type', () => {
        const result = createStatusMessage('info', 'Test description');

        assert.ok(result.embeds);
        assert.strictEqual(result.embeds.length, 1);

        const embed = result.embeds[0];
        assert.ok(embed && embed.data);
        assert.strictEqual(embed.data.description, 'Test description');
        assert.strictEqual(embed.data.color, 0x00AAFF);
        assert.strictEqual(embed.data.title, 'ℹ️ お知らせ');
    });

    await t.test('createStatusMessage: creates status message with success type', () => {
        const result = createStatusMessage('success', 'Success message');

        const embed = result.embeds[0];
        assert.strictEqual(embed.data.color, 0x57F287);
        assert.strictEqual(embed.data.title, '✅ 成功');
    });

    await t.test('createStatusMessage: handles unknown type by defaulting to info', () => {
        const result = createStatusMessage('unknown_type', 'Unknown message');

        const embed = result.embeds[0];
        assert.strictEqual(embed.data.color, 0x00AAFF);
        assert.strictEqual(embed.data.title, 'ℹ️ お知らせ');
    });

    await t.test('createStatusMessage: supports custom title', () => {
        const result = createStatusMessage('error', 'Error occurred', { title: 'Custom Error' });

        const embed = result.embeds[0];
        assert.strictEqual(embed.data.title, 'Custom Error');
        assert.strictEqual(embed.data.color, 0xED4245);
    });

    await t.test('createStatusMessage: includes extra embeds if provided', () => {
        const extraEmbed = new EmbedBuilder().setTitle('Extra');
        const result = createStatusMessage('warning', 'Warning desc', { extraEmbeds: [extraEmbed] });

        assert.strictEqual(result.embeds.length, 2);
        assert.strictEqual(result.embeds[1].data.title, 'Extra');
    });

    await t.test('createStatusMessage: adds optional flags, components, files, and content', () => {
        const options = {
            flags: 64,
            components: [{ type: 1, components: [] }],
            files: ['image.png'],
            content: 'Hello World'
        };
        const result = createStatusMessage('info', 'With options', options);

        assert.strictEqual(result.flags, 64);
        assert.deepStrictEqual(result.components, [{ type: 1, components: [] }]);
        assert.deepStrictEqual(result.files, ['image.png']);
        assert.strictEqual(result.content, 'Hello World');
    });

    await t.test('createStatusMessage: handles content when set to empty string or null', () => {
        const resultEmpty = createStatusMessage('info', 'Empty content', { content: '' });
        assert.strictEqual(resultEmpty.content, '');

        const resultNull = createStatusMessage('info', 'Null content', { content: null });
        assert.strictEqual(resultNull.content, null);
    });

    await t.test('createStatusMessage: normalises null description to empty string on primary embed', () => {
        const result = createStatusMessage('info', null);
        assert.strictEqual(result.embeds[0].data.description, '');
        assert.strictEqual(result.embeds[0].data.title, 'ℹ️ お知らせ');
    });
});
