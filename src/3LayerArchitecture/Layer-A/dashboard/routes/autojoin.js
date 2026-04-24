const express = require('express');
const router = express.Router({ mergeParams: true });
const {
    getGuildSettings, setGuildAutoJoin,
    getIgnoreChannels, addIgnoreChannel, removeIgnoreChannel,
    getAllowChannels, addAllowChannel, removeAllowChannel,
    getAllChannelPairs, addChannelPair, removeChannelPair,
    getAutoVCGenerators, addAutoVCGenerator, removeAutoVCGenerator
} = require('../../database');
const { ChannelType } = require('discord.js');
const { checkGuildAdmin } = require('../middleware/auth');

// ★修正: 引数でclientを受け取る
module.exports = (client) => {
    // 設定ページ表示
    // ※server.jsで /dashboard/:guildId/autojoin にマウントされているため、
    // ここへのGETは /dashboard/123/autojoin にアクセスした時のみ呼ばれる（基本は未使用）
    router.get('/', checkGuildAdmin, async (req, res) => {
        const guildId = req.params.guildId;
        // ★修正: req.clientではなく、渡されたclientを使用
        const guild = client.guilds.cache.get(guildId);

        if (!guild) return res.redirect('/dashboard');

        const settings = await getGuildSettings(guildId);
        const ignoreIds = await getIgnoreChannels(guildId);
        const allowIds = await getAllowChannels(guildId);
        const pairs = await getAllChannelPairs(guildId);
        const autovcGenerators = await getAutoVCGenerators(guildId);

        // IDリストをチャンネルオブジェクトに変換
        const ignoreChannels = ignoreIds.map(id => guild.channels.cache.get(id)).filter(c => c);
        const allowChannels = allowIds.map(id => guild.channels.cache.get(id)).filter(c => c);

        const pairData = pairs.map(p => ({
            voice: guild.channels.cache.get(p.voice_channel_id),
            text: guild.channels.cache.get(p.text_channel_id),
            isSelf: p.voice_channel_id === p.text_channel_id
        })).filter(p => p.voice);

        const autovcData = autovcGenerators.map(g => ({
            trigger: guild.channels.cache.get(g.channel_id),
            category: guild.channels.cache.get(g.category_id),
            archive: guild.channels.cache.get(g.text_channel_id),
            naming: g.naming_pattern
        })).filter(d => d.trigger);

        // チャンネル選択肢
        const voiceChannels = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
            .sort((a, b) => a.position - b.position);

        const textChannels = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildText)
            .sort((a, b) => a.position - b.position);

        const categories = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);

        res.render('partials/tab_autojoin', {
            guild,
            settings,
            ignoreChannels,
            allowChannels,
            pairs: pairData,
            autovc: autovcData,
            voiceChannels,
            textChannels,
            categories,
            activeTab: 'autojoin'
        });
    });

    // AutoJoin ON/OFF
    router.post('/toggle', checkGuildAdmin, async (req, res) => {
        const enable = req.body.enable === 'on';
        await setGuildAutoJoin(req.params.guildId, enable);
        // ★修正: メイン設定ページへリダイレクト
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // ペアリング追加
    router.post('/pair/add', checkGuildAdmin, async (req, res) => {
        const { voice_channel, text_channel, use_self_text } = req.body;
        const targetTextId = (use_self_text === 'on') ? voice_channel : text_channel;

        if (voice_channel && targetTextId) {
            await addChannelPair(req.params.guildId, voice_channel, targetTextId);
        }
        // ★修正: メイン設定ページへリダイレクト
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // ペアリング削除
    router.post('/pair/delete', checkGuildAdmin, async (req, res) => {
        await removeChannelPair(req.params.guildId, req.body.voice_channel);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // 除外リスト操作
    router.post('/ignore/add', checkGuildAdmin, async (req, res) => {
        if (req.body.channel_id) await addIgnoreChannel(req.params.guildId, req.body.channel_id);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });
    router.post('/ignore/delete', checkGuildAdmin, async (req, res) => {
        await removeIgnoreChannel(req.params.guildId, req.body.channel_id);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // 許可リスト操作
    router.post('/allow/add', checkGuildAdmin, async (req, res) => {
        if (req.body.channel_id) await addAllowChannel(req.params.guildId, req.body.channel_id);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });
    router.post('/allow/delete', checkGuildAdmin, async (req, res) => {
        await removeAllowChannel(req.params.guildId, req.body.channel_id);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // AutoVC 追加
    router.post('/autovc/add', checkGuildAdmin, async (req, res) => {
        const { trigger_vc, category, naming_pattern, log_channel } = req.body;
        if (trigger_vc && category && naming_pattern) {
            const archiveId = log_channel || null;
            await addAutoVCGenerator(req.params.guildId, trigger_vc, category, archiveId, naming_pattern);
        }
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // AutoVC 削除
    router.post('/autovc/delete', checkGuildAdmin, async (req, res) => {
        const { trigger_vc } = req.body;
        if (trigger_vc) {
            await removeAutoVCGenerator(req.params.guildId, trigger_vc);
        }
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    return router;
};