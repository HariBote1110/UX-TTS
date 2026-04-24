const express = require('express');
const router = express.Router({ mergeParams: true });
const { checkGuildMember } = require('../middleware/auth');
const {
    addUserPersonalDictionaryEntry,
    removeUserPersonalDictionaryEntryById,
} = require('../../database');

const MAX_ENTRIES = 10;

module.exports = () => {
    router.post('/add', checkGuildMember, async (req, res) => {
        const { guildId } = req.params;
        const { word, read } = req.body;
        const userId = req.user.id;

        if (!word || !read) {
            return res.redirect(`/dashboard/${guildId}?error=${encodeURIComponent('単語と読みを入力してください。')}#user-dictionary`);
        }

        const result = await addUserPersonalDictionaryEntry(userId, word, read);
        if (result && result.success === false && result.error === 'limit') {
            const max = result.max != null ? result.max : MAX_ENTRIES;
            return res.redirect(
                `/dashboard/${guildId}?error=${encodeURIComponent(`マイ辞書は最大${max}件までです。既存の語を削除するか、同じ語を上書きしてください。`)}#user-dictionary`
            );
        }
        if (!result || result.success !== true) {
            return res.redirect(
                `/dashboard/${guildId}?error=${encodeURIComponent('追加に失敗しました。')}#user-dictionary`
            );
        }
        return res.redirect(`/dashboard/${guildId}?success=${encodeURIComponent('マイ辞書を更新しました。')}#user-dictionary`);
    });

    router.post('/delete', checkGuildMember, async (req, res) => {
        const { guildId } = req.params;
        const userId = req.user.id;
        if (req.body.id) {
            await removeUserPersonalDictionaryEntryById(userId, req.body.id);
        }
        return res.redirect(`/dashboard/${guildId}#user-dictionary`);
    });

    return router;
};
