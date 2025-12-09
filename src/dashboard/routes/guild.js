const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middleware/auth');
const { 
    getUserSettings, setUserSpeakerId, setUserSpeed, setUserPitch, 
    setUserAutoJoin, 
    resetUserSettings,
    getGuildSettings, setGuildAutoJoin, setGuildReadJoin, setGuildReadLeave, setGuildActiveSpeech, // ★ ActiveSpeech (Server)
    getDictionaryEntries, getIgnoreChannels, getAllowChannels, getAllChannelPairs,
    getGuildUsage, getVoicePresets
} = require('../../database');
const { OJT_SPEAKERS } = require('../../utils/helpers');

module.exports = (client) => {
    // 設定画面表示
    router.get('/:guildId', checkAuth, (req, res) => {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId);
        const userGuildData = req.user.guilds.find(g => g.id === guildId);

        if (!guild || !userGuildData) return res.redirect('/dashboard');

        const isGuildAdmin = (userGuildData.permissions & 0x8) === 0x8;
        const userSettings = getUserSettings(guildId, req.user.id);
        const guildSettings = getGuildSettings(guildId);
        const speakers = client.speakerCache || [];

        const dictionary = getDictionaryEntries(guildId);
        const ignoreChannels = getIgnoreChannels(guildId);
        const allowChannels = getAllowChannels(guildId);
        const channelPairs = getAllChannelPairs(guildId);

        const usage = getGuildUsage(guildId);
        const vvxThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
        const totalLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;
        
        const channels = guild.channels.cache;
        const voiceChannels = channels.filter(c => c.isVoiceBased()).map(c => ({ id: c.id, name: c.name }));
        const textChannels = channels.filter(c => c.isTextBased() && !c.isVoiceBased()).map(c => ({ id: c.id, name: c.name }));

        const presets = getVoicePresets(req.user.id);
        const { success, error } = req.query;

        res.render('settings', { 
            user: req.user, guild, userSettings, guildSettings, isGuildAdmin,
            speakers, ojtSpeakers: OJT_SPEAKERS,
            dictionary, ignoreChannels, allowChannels, channelPairs,
            voiceChannels, textChannels,
            usage, limits: { vvxThreshold, totalLimit }, presets,
            messages: { success, error }
        });
    });

    // 設定保存
    router.post('/:guildId/save', checkAuth, (req, res) => {
        const guildId = req.params.guildId;
        const userId = req.user.id;
        const body = req.body;
        
        console.log(`[Dashboard] Settings Save: User=${userId}, Speed=${body.speed}, Pitch=${body.pitch}, Speaker=${body.speakerSelection}`);

        // 1. 数値変換
        const speed = parseFloat(body.speed);
        const pitch = parseFloat(body.pitch);

        // 2. データベース更新 (個人設定)
        if (!isNaN(speed)) setUserSpeed(guildId, userId, speed);
        if (!isNaN(pitch)) setUserPitch(guildId, userId, pitch);
        
        if (body.speakerSelection) {
            const [type, idStr] = body.speakerSelection.split('_');
            const speakerId = parseInt(idStr, 10);
            if (!isNaN(speakerId)) {
                setUserSpeakerId(guildId, userId, speakerId, type);
            }
        }

        setUserAutoJoin(guildId, userId, body.autoJoin === 'on');
        // ★ 削除: setUserActiveSpeech (個人設定としては廃止)

        // 3. サーバー設定 (管理者のみ)
        const userGuildData = req.user.guilds.find(g => g.id === guildId);
        if (userGuildData && (userGuildData.permissions & 0x8) === 0x8) {
            setGuildAutoJoin(guildId, body.serverAutoJoin === 'on');
            setGuildReadJoin(guildId, body.readJoin === 'on');
            setGuildReadLeave(guildId, body.readLeave === 'on');
            
            // ★ 追加: サーバーActiveSpeech設定
            setGuildActiveSpeech(guildId, body.serverActiveSpeech === 'on');
        }

        // 4. VoiceManagerへの反映
        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            if (!isNaN(speed)) manager.setSpeed(userId, speed);
            if (!isNaN(pitch)) manager.setPitch(userId, pitch);
            
            // ★ 追加: サーバー設定の変更をBotの状態(Self-Deafなど)に即座に反映
            if (manager.updateSelfDeaf) {
                manager.updateSelfDeaf();
            }
        }

        res.redirect(`/dashboard/${guildId}?success=${encodeURIComponent('設定を保存しました')}`);
    });

    // 設定リセット
    router.post('/:guildId/reset', checkAuth, (req, res) => {
        resetUserSettings(req.params.guildId, req.user.id);
        
        // Managerにも反映
        const manager = client.guildVoiceManagers.get(req.params.guildId);
        if (manager && manager.isActive()) {
            manager.resetSettings(req.user.id);
        }

        res.redirect(`/dashboard/${req.params.guildId}?success=${encodeURIComponent('設定をリセットしました')}`);
    });

    return router;
};