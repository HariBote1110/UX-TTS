const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middleware/auth');
const { ChannelType } = require('discord.js'); // ★追加
const {
    getUserSettings, setUserSpeakerId, setUserSpeed, setUserPitch,
    setUserAutoJoin,
    resetUserSettings,
    getGuildSettings, setGuildAutoJoin, setGuildReadJoin, setGuildReadLeave, setGuildActiveSpeech,
    getDictionaryEntries, getUserPersonalDictionaryEntries, getIgnoreChannels, getAllowChannels, getAllChannelPairs,
    getGuildUsage, getVoicePresets,
    getAutoVCGenerators // ★追加
} = require('../../database');
const { OJT_SPEAKERS } = require('../../utils/helpers');

module.exports = (client) => {
    // 設定画面表示
    router.get('/:guildId', checkAuth, async (req, res) => {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId);
        const userGuildData = req.user.guilds.find(g => g.id === guildId);

        if (!guild || !userGuildData) return res.redirect('/dashboard');

        const isGuildAdmin = (userGuildData.permissions & 0x8) === 0x8;
        const userSettings = await getUserSettings(guildId, req.user.id);
        const guildSettings = await getGuildSettings(guildId);
        const speakers = client.speakerCache || [];

        const dictionary = await getDictionaryEntries(guildId);
        const userPersonalDictionary = await getUserPersonalDictionaryEntries(req.user.id);
        const ignoreIds = await getIgnoreChannels(guildId);
        const allowIds = await getAllowChannels(guildId);
        const rawPairs = await getAllChannelPairs(guildId); // 変数名変更
        const rawAutoVC = await getAutoVCGenerators(guildId); // ★追加: AutoVCデータ取得

        const usage = await getGuildUsage(guildId);
        const vvxThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
        const totalLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;

        const channels = guild.channels.cache;

        // View用データ整形: チャンネルリスト
        const voiceChannels = channels.filter(c => c.isVoiceBased()).map(c => ({ id: c.id, name: c.name }));
        const textChannels = channels.filter(c => c.isTextBased() && !c.isVoiceBased()).map(c => ({ id: c.id, name: c.name }));
        // ★追加: カテゴリリスト (AutoVC作成先用)
        const categories = channels.filter(c => c.type === ChannelType.GuildCategory).map(c => ({ id: c.id, name: c.name }));

        // View用データ整形: 除外/許可チャンネル (IDリスト -> チャンネルオブジェクト)
        const ignoreChannels = ignoreIds.map(id => channels.get(id)).filter(c => c).map(c => ({ id: c.id, name: c.name }));
        const allowChannels = allowIds.map(id => channels.get(id)).filter(c => c).map(c => ({ id: c.id, name: c.name }));

        // ★修正: ペアリング情報の整形 (ID -> オブジェクト & VC内チャット判定)
        const pairs = rawPairs.map(p => ({
            voice: channels.get(p.voice_channel_id),
            text: channels.get(p.text_channel_id),
            isSelf: p.voice_channel_id === p.text_channel_id
        })).filter(p => p.voice); // VCが存在するもののみ

        // ★追加: AutoVC情報の整形
        const autovc = rawAutoVC.map(g => ({
            trigger: channels.get(g.channel_id),
            category: channels.get(g.category_id),
            archive: channels.get(g.text_channel_id),
            naming: g.naming_pattern
        })).filter(d => d.trigger);

        const presets = await getVoicePresets(req.user.id);
        const { success, error } = req.query;

        res.render('settings', {
            user: req.user, guild, userSettings, guildSettings, isGuildAdmin,
            speakers, ojtSpeakers: OJT_SPEAKERS,
            dictionary,
            userPersonalDictionary,
            ignoreChannels, allowChannels,
            pairs, autovc, // ★追加・修正したデータを渡す
            voiceChannels, textChannels, categories, // ★categoriesを追加
            usage, limits: { vvxThreshold, totalLimit }, presets,
            messages: { success, error }
        });
    });

    // 設定保存
    router.post('/:guildId/save', checkAuth, async (req, res) => {
        const guildId = req.params.guildId;
        const userId = req.user.id;
        const body = req.body;

        console.log(`[Dashboard] Settings Save: User=${userId}, Speed=${body.speed}, Pitch=${body.pitch}, Speaker=${body.speakerSelection}`);

        // 1. 数値変換
        const speed = parseFloat(body.speed);
        const pitch = parseFloat(body.pitch);

        // 2. データベース更新 (個人設定)
        if (!isNaN(speed)) await setUserSpeed(guildId, userId, speed);
        if (!isNaN(pitch)) await setUserPitch(guildId, userId, pitch);

        if (body.speakerSelection) {
            const [type, idStr] = body.speakerSelection.split('_');
            const speakerId = parseInt(idStr, 10);
            if (!isNaN(speakerId)) {
                await setUserSpeakerId(guildId, userId, speakerId, type);
            }
        }

        await setUserAutoJoin(guildId, userId, body.autoJoin === 'on');

        // 3. サーバー設定 (管理者のみ)
        const userGuildData = req.user.guilds.find(g => g.id === guildId);
        if (userGuildData && (userGuildData.permissions & 0x8) === 0x8) {
            await setGuildAutoJoin(guildId, body.serverAutoJoin === 'on');
            await setGuildReadJoin(guildId, body.readJoin === 'on');
            await setGuildReadLeave(guildId, body.readLeave === 'on');
            await setGuildActiveSpeech(guildId, body.serverActiveSpeech === 'on');
        }

        // 4. VoiceManagerへの反映
        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            if (!isNaN(speed)) manager.setSpeed(userId, speed);
            if (!isNaN(pitch)) manager.setPitch(userId, pitch);

            if (manager.updateSelfDeaf) {
                manager.updateSelfDeaf();
            }
        }

        res.redirect(`/dashboard/${guildId}?success=${encodeURIComponent('設定を保存しました')}`);
    });

    // 設定リセット
    router.post('/:guildId/reset', checkAuth, async (req, res) => {
        await resetUserSettings(req.params.guildId, req.user.id);

        // Managerにも反映
        const manager = client.guildVoiceManagers.get(req.params.guildId);
        if (manager && manager.isActive()) {
            manager.resetSettings(req.user.id);
        }

        res.redirect(`/dashboard/${req.params.guildId}?success=${encodeURIComponent('設定をリセットしました')}`);
    });

    return router;
};