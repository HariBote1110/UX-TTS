const { MessageFlags } = require('discord.js');
const { createStatusMessage } = require('../../../utils/helpers');
const {
    addDictionaryEntry,
    removeDictionaryEntry,
    addUserPersonalDictionaryEntry,
    removeUserPersonalDictionaryEntryById,
    getUserPersonalDictionaryEntries,
    setUserSpeed,
    setUserPitch
} = require('../../../database');
const feedbackManager = require('../../../utils/feedbackManager');
const { sendFeedbackLog } = require('./buttons/handleFeedback');

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // フィードバック詳細モーダル
    if (customId === 'feedback_detail_modal_submit') {
        const detail = interaction.fields.getTextInputValue('feedback_detail_text');
        feedbackManager.markSubmitted(interaction.user.id);
        await interaction.reply({
            content: '📝 詳しいフィードバックをありがとうございます！いただいたご意見は改善に役立てます。',
            flags: [MessageFlags.Ephemeral]
        });
        await sendFeedbackLog(client, interaction.user, guildId, 'bad', detail);
        return;
    }

    // 辞書登録
    if (customId === 'dict_add_modal_submit') {
        const word = interaction.fields.getTextInputValue('dict_word');
        const read = interaction.fields.getTextInputValue('dict_read');
        await addDictionaryEntry(guildId, word, read);
        await interaction.reply(createStatusMessage('success', `辞書に登録しました: **${word}** → 「${read}」`, { flags: [MessageFlags.Ephemeral] }));
    }
    // 辞書削除
    else if (customId === 'dict_delete_modal_submit') {
        const word = interaction.fields.getTextInputValue('dict_delete_word');
        const success = await removeDictionaryEntry(guildId, word);
        if (success) {
            await interaction.reply(createStatusMessage('success', `辞書から削除しました: **${word}**`, { title: '🗑️ 削除完了', flags: [MessageFlags.Ephemeral] }));
        } else {
            await interaction.reply(createStatusMessage('warning', `その単語は登録されていません: **${word}**`, { flags: [MessageFlags.Ephemeral] }));
        }
    }

    // マイ辞書
    else if (customId === 'user_dict_add_modal_submit') {
        const word = interaction.fields.getTextInputValue('user_dict_word');
        const read = interaction.fields.getTextInputValue('user_dict_read');
        const result = await addUserPersonalDictionaryEntry(interaction.user.id, word, read);
        if (result && result.success === false && result.error === 'limit') {
            const max = result.max != null ? result.max : 10;
            await interaction.reply(createStatusMessage('warning', `マイ辞書は最大 **${max}** 語までです。別の語を増やすには削除するか、同じ表記で上書きしてください。`, { title: '🔖 マイ辞書', flags: [MessageFlags.Ephemeral] }));
            return;
        }
        if (!result || result.success !== true) {
            await interaction.reply(createStatusMessage('error', '登録に失敗しました。', { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        await interaction.reply(createStatusMessage('success', `辞書に登録しました: **${word}** → 「${read}」`, { flags: [MessageFlags.Ephemeral] }));
    }
    else if (customId === 'user_dict_delete_modal_submit') {
        const word = interaction.fields.getTextInputValue('user_dict_delete_word').trim();
        const entries = await getUserPersonalDictionaryEntries(interaction.user.id);
        const match = entries.find((e) => e.word === word);
        if (!match) {
            await interaction.reply(createStatusMessage('warning', `その単語は登録されていません: **${word}**`, { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        const ok = await removeUserPersonalDictionaryEntryById(interaction.user.id, match.id);
        if (ok) {
            await interaction.reply(createStatusMessage('success', `辞書から削除しました: **${word}**`, { title: '🗑️ 削除完了', flags: [MessageFlags.Ephemeral] }));
        } else {
            await interaction.reply(createStatusMessage('warning', '削除に失敗しました。', { flags: [MessageFlags.Ephemeral] }));
        }
    }

    // ====================================================
    // ★ 音声設定 (話速・ピッチ)
    // ====================================================
    else if (customId === 'config_speed_modal_submit') {
        const input = interaction.fields.getTextInputValue('config_speed_input');
        const speed = parseFloat(input);

        // バリデーション
        if (isNaN(speed)) {
            await interaction.reply(createStatusMessage('error', '数値を入力してください（例: 1.2）。', { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        if (speed < 0.5) {
            await interaction.reply(createStatusMessage('error', `値が小さすぎます。最小値は **0.5** です（入力値: ${speed}）。`, { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        if (speed > 2.0) {
            await interaction.reply(createStatusMessage('error', `値が大きすぎます。最大値は **2.0** です（入力値: ${speed}）。`, { flags: [MessageFlags.Ephemeral] }));
            return;
        }

        await setUserSpeed(guildId, interaction.user.id, speed);

        // 接続中のVoiceManagerがあれば設定を即反映
        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            await manager.setSpeed(interaction.user.id, speed);
        }

        await interaction.reply(createStatusMessage('success', `あなたの話速を **${speed}** に設定しました。`, { flags: [MessageFlags.Ephemeral] }));
    }

    else if (customId === 'config_pitch_modal_submit') {
        const input = interaction.fields.getTextInputValue('config_pitch_input');
        const pitch = parseFloat(input);

        if (isNaN(pitch)) {
            await interaction.reply(createStatusMessage('error', '数値を入力してください（例: 0.05）。', { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        if (pitch < -0.15) {
            await interaction.reply(createStatusMessage('error', `値が小さすぎます。最小値は **-0.15** です（入力値: ${pitch}）。`, { flags: [MessageFlags.Ephemeral] }));
            return;
        }
        if (pitch > 0.15) {
            await interaction.reply(createStatusMessage('error', `値が大きすぎます。最大値は **0.15** です（入力値: ${pitch}）。`, { flags: [MessageFlags.Ephemeral] }));
            return;
        }

        await setUserPitch(guildId, interaction.user.id, pitch);

        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            await manager.setPitch(interaction.user.id, pitch);
        }

        await interaction.reply(createStatusMessage('success', `あなたのピッチを **${pitch}** に設定しました。`, { flags: [MessageFlags.Ephemeral] }));
    }
};
