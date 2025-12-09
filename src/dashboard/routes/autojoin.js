const express = require('express');
const router = express.Router({ mergeParams: true });
const { checkAuth } = require('../middleware/auth');
const { 
    addAllowChannel, addIgnoreChannel, removeAllowChannel, removeIgnoreChannel,
    addChannelPair, removeChannelPair
} = require('../../database');

module.exports = () => {
    // ペアリング操作
    router.post('/pair/add', checkAuth, (req, res) => {
        const { voiceId, textId } = req.body;
        if (voiceId && textId) addChannelPair(req.params.guildId, voiceId, textId);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    router.post('/pair/delete', checkAuth, (req, res) => {
        const { voiceId } = req.body;
        if (voiceId) removeChannelPair(req.params.guildId, voiceId);
        res.redirect(`/dashboard/${req.params.guildId}#autojoin`);
    });

    // 許可・除外リスト操作
    router.post('/autojoin/:type/add', checkAuth, (req, res) => {
        const { guildId, type } = req.params;
        const { channelId } = req.body;
        if (type === 'allow') addAllowChannel(guildId, channelId);
        if (type === 'ignore') addIgnoreChannel(guildId, channelId);
        res.redirect(`/dashboard/${guildId}#autojoin`);
    });

    router.post('/autojoin/:type/delete', checkAuth, (req, res) => {
        const { guildId, type } = req.params;
        const { channelId } = req.body;
        if (type === 'allow') removeAllowChannel(guildId, channelId);
        if (type === 'ignore') removeIgnoreChannel(guildId, channelId);
        res.redirect(`/dashboard/${guildId}#autojoin`);
    });

    return router;
};