const express = require('express');
const multer = require('multer');
const { checkAuth } = require('../middleware/auth');

// In-memory file upload (dictionary import)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

function hasAdminPermission(permissionValue) {
    if (permissionValue == null) return false;
    try {
        const value = typeof permissionValue === 'string' ? BigInt(permissionValue) : BigInt(permissionValue);
        return (value & 0x8n) === 0x8n;
    } catch {
        return false;
    }
}

function getUserGuilds(user) {
    if (!user || !Array.isArray(user.guilds)) return [];
    return user.guilds
        .map((guild) => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
                : null,
            permissions: guild.permissions,
            isAdmin: hasAdminPermission(guild.permissions),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function checkGuildAdmin(req, res, next) {
    const { guildId } = req.params;
    const guilds = getUserGuilds(req.user);
    const guild = guilds.find((g) => g.id === guildId);
    if (!guild) {
        return res.redirect('/dashboard?error=' + encodeURIComponent('Guildの指定が不正です'));
    }
    if (!guild.isAdmin) {
        return res.redirect(
            `/dashboard/${encodeURIComponent(guildId)}?error=` + encodeURIComponent('管理者権限が必要です')
        );
    }
    next();
}

module.exports = ({ layerdClient, discordRestClient }) => {
    const router = express.Router();

    // ─── Dashboard Home (Guild selection) ────────────────────────────────────

    router.get('/', checkAuth, async (req, res) => {
        const allUserGuilds = getUserGuilds(req.user);

        // Filter to only guilds the Bot has joined
        let guilds = allUserGuilds;
        if (discordRestClient) {
            try {
                const botGuildIds = await discordRestClient.getBotGuildIds();
                if (botGuildIds.size > 0) {
                    guilds = allUserGuilds.filter((g) => botGuildIds.has(g.id));
                }
            } catch (error) {
                console.error('[Layer-E] getBotGuildIds error:', error.message);
                // Fail open: show all guilds if the API call fails
                guilds = allUserGuilds;
            }
        }

        res.render('index_dashboard', {
            user: req.user,
            guilds,
            messages: {
                success: req.query.success || null,
                error: req.query.error || null,
            },
        });
    });

    // ─── Guild Detail (Settings page) ────────────────────────────────────────

    router.get('/:guildId', checkAuth, async (req, res) => {
        const { guildId } = req.params;
        const guilds = getUserGuilds(req.user);
        const guild = guilds.find((g) => g.id === guildId);

        if (!guild) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('指定されたGuildにアクセスできません'));
        }

        try {
            // Fetch all data in parallel
            const [
                usage,
                guildSettings,
                dictionary,
                rawUserPersonalDictionary,
                ignoreChannelIds,
                allowChannelIds,
                channelPairs,
                autovcGenerators,
                channelData,
            ] = await Promise.all([
                layerdClient.getGuildUsage(guildId),
                layerdClient.getGuildSettings(null, guildId),
                layerdClient.getDictionary(null, guildId),
                layerdClient.getUserPersonalDictionary(req.user.id),
                layerdClient.getIgnoreChannels(null, guildId),
                layerdClient.getAllowChannels(null, guildId),
                layerdClient.getChannelPairs(null, guildId),
                layerdClient.getAutoVCGenerators(null, guildId),
                discordRestClient ? discordRestClient.getGuildChannels(guildId) : Promise.resolve({ voiceChannels: [], textChannels: [], categories: [] }),
            ]);

            const { voiceChannels, textChannels, categories } = channelData;

            // Build channel map for ID → name resolution
            const channelMap = new Map([
                ...voiceChannels.map((c) => [c.id, c]),
                ...textChannels.map((c) => [c.id, c]),
                ...categories.map((c) => [c.id, c]),
            ]);

            // Resolve ignore/allow channel IDs to objects
            const ignoreChannels = ignoreChannelIds
                .map((id) => channelMap.get(id) || { id, name: `(不明: ${id})` });
            const allowChannels = allowChannelIds
                .map((id) => channelMap.get(id) || { id, name: `(不明: ${id})` });

            // Resolve channel pairs
            const pairs = channelPairs
                .map((p) => {
                    const voiceId = p.voice_channel_id || p.voiceChannelId;
                    const textId = p.text_channel_id || p.textChannelId;
                    return {
                        voice: channelMap.get(voiceId) || { id: voiceId, name: `(不明: ${voiceId})` },
                        text: channelMap.get(textId) || { id: textId, name: `(不明: ${textId})` },
                        isSelf: voiceId === textId,
                    };
                })
                .filter((p) => p.voice);

            // Resolve AutoVC generators
            const autovcData = autovcGenerators
                .map((g) => {
                    const triggerId = g.channel_id || g.triggerChannelId;
                    const categoryId = g.category_id || g.categoryId;
                    const archiveId = g.text_channel_id || g.archiveChannelId;
                    return {
                        trigger: channelMap.get(triggerId) || { id: triggerId, name: `(不明: ${triggerId})` },
                        category: categoryId ? (channelMap.get(categoryId) || { id: categoryId, name: `(不明: ${categoryId})` }) : null,
                        archive: archiveId ? (channelMap.get(archiveId) || { id: archiveId, name: `(不明: ${archiveId})` }) : null,
                        naming: g.naming_pattern || g.namingPattern || '{user}の部屋',
                    };
                })
                .filter((g) => g.trigger);

            // Dictionary normalise field names (Layer-D may return read_as or read)
            const normalisedDictionary = dictionary.map((e) => ({
                id: e.id,
                word: e.word,
                read_as: e.read_as || e.read,
            }));

            const userPersonalDictionary = rawUserPersonalDictionary.map((e) => ({
                id: e.id,
                word: e.word,
                read_as: e.read_as || e.read,
            }));

            const dictionaryCount = normalisedDictionary.length;
            const ignoreCount = ignoreChannelIds.length;
            const allowCount = allowChannelIds.length;
            const autovcCount = autovcGenerators.length;

            return res.render('settings', {
                user: req.user,
                guilds,
                guild: { ...guild, icon: guild.icon ? guild.icon.replace('.png', '') : null }, // raw icon hash for Layer-A template compat
                selectedGuild: guild,
                usage,
                guildSettings,
                isGuildAdmin: guild.isAdmin,
                dictionary: normalisedDictionary,
                userPersonalDictionary,
                ignoreChannels,
                allowChannels,
                pairs,
                autovc: autovcData,
                voiceChannels,
                textChannels,
                categories,
                counts: {
                    dictionary: dictionaryCount,
                    ignore: ignoreCount,
                    allow: allowCount,
                    autovc: autovcCount,
                },
                messages: {
                    success: req.query.success || null,
                    error: req.query.error || null,
                },
            });
        } catch (error) {
            console.error('[Layer-E] Guild detail error:', error);
            return res.redirect(
                `/dashboard?error=${encodeURIComponent(`Layer-D 連携エラー: ${error.message}`)}`
            );
        }
    });

    // ─── Guild Settings (save) ────────────────────────────────────────────────

    router.post('/:guildId/guild-settings', checkAuth, async (req, res) => {
        const { guildId } = req.params;
        const guilds = getUserGuilds(req.user);
        const guild = guilds.find((g) => g.id === guildId);

        if (!guild) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('Guildの指定が不正です'));
        }
        if (!guild.isAdmin) {
            return res.redirect(`/dashboard/${encodeURIComponent(guildId)}?error=` + encodeURIComponent('管理者権限が必要です'));
        }

        const values = {
            auto_join_enabled: req.body.auto_join_enabled === 'on',
            read_join: req.body.read_join === 'on',
            read_leave: req.body.read_leave === 'on',
            active_speech: req.body.active_speech === 'on',
        };

        try {
            await layerdClient.updateGuildSettings(null, guildId, values);
            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?success=` + encodeURIComponent('Guild設定を更新しました')
            );
        } catch (error) {
            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent(`更新に失敗しました: ${error.message}`)}`
            );
        }
    });

    // ─── AutoJoin toggle ─────────────────────────────────────────────────────

    router.post('/:guildId/autojoin/toggle', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const enable = req.body.enable === 'on';
        try {
            await layerdClient.setGuildAutoJoin(null, guildId, enable);
        } catch (error) {
            console.error('[Layer-E] autojoin toggle error:', error.message);
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    // ─── Channel Pairs ────────────────────────────────────────────────────────

    router.post('/:guildId/autojoin/pair/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { voice_channel, text_channel, use_self_text } = req.body;
        const targetTextId = use_self_text === 'on' ? voice_channel : text_channel;

        if (voice_channel && targetTextId) {
            try {
                await layerdClient.addChannelPair(null, guildId, voice_channel, targetTextId);
            } catch (error) {
                console.error('[Layer-E] pair/add error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    router.post('/:guildId/autojoin/pair/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { voice_channel } = req.body;
        if (voice_channel) {
            try {
                await layerdClient.removeChannelPair(null, guildId, voice_channel);
            } catch (error) {
                console.error('[Layer-E] pair/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    // ─── Ignore Channels ─────────────────────────────────────────────────────

    router.post('/:guildId/autojoin/ignore/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { channel_id } = req.body;
        if (channel_id) {
            try {
                await layerdClient.addIgnoreChannel(null, guildId, channel_id);
            } catch (error) {
                console.error('[Layer-E] ignore/add error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    router.post('/:guildId/autojoin/ignore/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { channel_id } = req.body;
        if (channel_id) {
            try {
                await layerdClient.removeIgnoreChannel(null, guildId, channel_id);
            } catch (error) {
                console.error('[Layer-E] ignore/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    // ─── Allow Channels ──────────────────────────────────────────────────────

    router.post('/:guildId/autojoin/allow/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { channel_id } = req.body;
        if (channel_id) {
            try {
                await layerdClient.addAllowChannel(null, guildId, channel_id);
            } catch (error) {
                console.error('[Layer-E] allow/add error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    router.post('/:guildId/autojoin/allow/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { channel_id } = req.body;
        if (channel_id) {
            try {
                await layerdClient.removeAllowChannel(null, guildId, channel_id);
            } catch (error) {
                console.error('[Layer-E] allow/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    // ─── AutoVC Generators ────────────────────────────────────────────────────

    router.post('/:guildId/autojoin/autovc/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { trigger_vc, category, naming_pattern, log_channel } = req.body;
        if (trigger_vc && category && naming_pattern) {
            try {
                await layerdClient.addAutoVCGenerator(
                    null, guildId, trigger_vc, category, log_channel || null, naming_pattern
                );
            } catch (error) {
                console.error('[Layer-E] autovc/add error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    router.post('/:guildId/autojoin/autovc/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { trigger_vc } = req.body;
        if (trigger_vc) {
            try {
                await layerdClient.removeAutoVCGenerator(null, guildId, trigger_vc);
            } catch (error) {
                console.error('[Layer-E] autovc/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#autojoin`);
    });

    // ─── User personal dictionary (any guild member) ─────────────────────────

    router.post('/:guildId/user-dictionary/add', checkAuth, async (req, res) => {
        const { guildId } = req.params;
        const guilds = getUserGuilds(req.user);
        const guild = guilds.find((g) => g.id === guildId);
        if (!guild) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('Guildの指定が不正です'));
        }
        const { word, read } = req.body;
        if (!word || !read) {
            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent('単語と読みを入力してください。')}#user-dictionary`
            );
        }
        try {
            const result = await layerdClient.addUserPersonalDictionaryEntry(req.user.id, word, read);
            if (result && result.success === false && result.error === 'limit') {
                const max = result.max != null ? result.max : 10;
                return res.redirect(
                    `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent(`マイ辞書は最大${max}件までです。既存の語を削除するか、同じ語を上書きしてください。`)}#user-dictionary`
                );
            }
            if (!result || result.success !== true) {
                return res.redirect(
                    `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent('追加に失敗しました。')}#user-dictionary`
                );
            }
        } catch (error) {
            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent('追加に失敗しました: ' + error.message)}#user-dictionary`
            );
        }
        return res.redirect(
            `/dashboard/${encodeURIComponent(guildId)}?success=${encodeURIComponent('マイ辞書を更新しました。')}#user-dictionary`
        );
    });

    router.post('/:guildId/user-dictionary/delete', checkAuth, async (req, res) => {
        const { guildId } = req.params;
        const guilds = getUserGuilds(req.user);
        const guild = guilds.find((g) => g.id === guildId);
        if (!guild) {
            return res.redirect('/dashboard?error=' + encodeURIComponent('Guildの指定が不正です'));
        }
        const { id } = req.body;
        if (id) {
            try {
                await layerdClient.deleteUserPersonalDictionaryEntry(req.user.id, id);
            } catch (error) {
                console.error('[Layer-E] user-dict/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#user-dictionary`);
    });

    // ─── Dictionary ──────────────────────────────────────────────────────────

    router.post('/:guildId/dictionary/add', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { word, read } = req.body;
        if (word && read) {
            try {
                await layerdClient.addDictionaryEntry(null, guildId, word, read);
            } catch (error) {
                return res.redirect(
                    `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent('追加に失敗しました: ' + error.message)}#dictionary`
                );
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#dictionary`);
    });

    router.post('/:guildId/dictionary/delete', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { id } = req.body;
        if (id) {
            try {
                await layerdClient.deleteDictionaryEntry(null, guildId, id);
            } catch (error) {
                console.error('[Layer-E] dict/delete error:', error.message);
            }
        }
        return res.redirect(`/dashboard/${encodeURIComponent(guildId)}#dictionary`);
    });

    router.post('/:guildId/dictionary/import', checkAuth, checkGuildAdmin, upload.single('dictFile'), async (req, res) => {
        const { guildId } = req.params;
        try {
            const file = req.file;
            const mode = req.body.importMode || 'merge';
            if (!file) throw new Error('ファイルが選択されていません。');

            // Encoding detection
            let fileContent = '';
            const buffer = file.buffer;
            if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
                fileContent = new TextDecoder('utf-16le').decode(buffer);
            } else if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
                fileContent = new TextDecoder('utf-16be').decode(buffer);
            } else {
                fileContent = new TextDecoder('utf-8').decode(buffer);
                if (fileContent.charCodeAt(0) === 0xFEFF) fileContent = fileContent.slice(1);
            }

            let entries = [];
            try {
                const json = JSON.parse(fileContent);
                if (Array.isArray(json)) {
                    entries = json
                        .map((item) => ({ word: item.word, read: item.read || item.read_as || item.yomi }))
                        .filter((e) => e.word && e.read);
                } else if (json.kind === 'com.kuroneko6423.kuronekottsbot.dictionary' && json.data) {
                    entries = Object.entries(json.data).map(([k, v]) => ({ word: k, read: v }));
                } else {
                    entries = Object.entries(json).map(([k, v]) => ({ word: k, read: String(v) }));
                }
            } catch {
                const lines = fileContent.split(/\r?\n/);
                lines.forEach((line) => {
                    if (!line.trim()) return;
                    let parts = line.split(',');
                    if (parts.length < 2) parts = line.split('\t');
                    if (parts.length < 2) parts = line.split('=');
                    if (parts.length >= 2) {
                        const word = parts[0].trim();
                        const read = parts.slice(1).join(',').trim();
                        if (word && read) entries.push({ word, read });
                    }
                });
            }

            if (entries.length === 0) {
                throw new Error('有効な辞書データが見つかりませんでした。形式を確認してください。');
            }

            if (mode === 'replace') {
                await layerdClient.clearDictionary(null, guildId);
            }

            const result = await layerdClient.importDictionary(null, guildId, entries);
            const count = (result && result.count != null) ? result.count : entries.length;

            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?success=${encodeURIComponent(`${count}件の単語をインポートしました (${mode === 'replace' ? '全置換' : '追加更新'})`)}#dictionary`
            );
        } catch (error) {
            console.error('[Dictionary Import Error]', error);
            return res.redirect(
                `/dashboard/${encodeURIComponent(guildId)}?error=${encodeURIComponent('インポート失敗: ' + error.message)}#dictionary`
            );
        }
    });

    router.get('/:guildId/dictionary/export', checkAuth, checkGuildAdmin, async (req, res) => {
        const { guildId } = req.params;
        const { format } = req.query;
        const dictionary = await layerdClient.getDictionary(null, guildId);
        const entries = dictionary.map((e) => ({ id: e.id, word: e.word, read_as: e.read_as || e.read }));

        let buffer;
        let fileName;
        let contentType = 'application/json';

        if (format === 'voiceroid') {
            const dataMap = {};
            entries.forEach((e) => { dataMap[e.word] = e.read_as; });
            const exportObj = { kind: 'com.kuroneko6423.kuronekottsbot.dictionary', version: 0, data: dataMap };
            buffer = Buffer.from(JSON.stringify(exportObj, null, 2), 'utf-8');
            fileName = 'dictionary_voiceroid.json';
        } else if (format === 'shovel') {
            const csvLines = entries.map((e) => `${e.word}, ${e.read_as}`);
            const csvStr = csvLines.join('\r\n');
            const bom = Buffer.from([0xFF, 0xFE]);
            const content = Buffer.from(csvStr, 'utf16le');
            buffer = Buffer.concat([bom, content]);
            fileName = 'dictionary.dict';
            contentType = 'text/plain';
        } else {
            const data = entries.map((e) => ({ word: e.word, read: e.read_as }));
            buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
            fileName = 'dictionary_uxtts.json';
        }

        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', contentType);
        return res.send(buffer);
    });

    return router;
};
