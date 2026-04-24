const { MessageFlags } = require('discord.js');
const { 
    addDictionaryEntry, 
    removeDictionaryEntry,
    setUserSpeed,
    setUserPitch
} = require('../../../database');

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // 辞書登録
    if (customId === 'dict_add_modal_submit') {
        const word = interaction.fields.getTextInputValue('dict_word');
        const read = interaction.fields.getTextInputValue('dict_read');
        addDictionaryEntry(guildId, word, read);
        await interaction.reply({ content: `✅ 辞書に登録しました: **${word}** → 「${read}」`, flags: [MessageFlags.Ephemeral] });
    }
    // 辞書削除
    else if (customId === 'dict_delete_modal_submit') {
        const word = interaction.fields.getTextInputValue('dict_delete_word');
        const success = removeDictionaryEntry(guildId, word);
        if (success) {
            await interaction.reply({ content: `🗑️ 辞書から削除しました: **${word}**`, flags: [MessageFlags.Ephemeral] });
        } else {
            await interaction.reply({ content: `⚠️ その単語は登録されていません: **${word}**`, flags: [MessageFlags.Ephemeral] });
        }
    }

    // ====================================================
    // ★ 音声設定 (話速・ピッチ)
    // ====================================================
    else if (customId === 'config_speed_modal_submit') {
        const input = interaction.fields.getTextInputValue('config_speed_input');
        const speed = parseFloat(input);

        // バリデーション
        if (isNaN(speed) || speed < 0.5 || speed > 2.0) {
            await interaction.reply({ content: '❌ 無効な値です。0.5 から 2.0 の間の数値を入力してください。', flags: [MessageFlags.Ephemeral] });
            return;
        }

        setUserSpeed(guildId, interaction.user.id, speed);
        
        // 接続中のVoiceManagerがあれば設定を即反映
        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            manager.setSpeed(interaction.user.id, speed);
        }

        await interaction.reply({ content: `✅ あなたの話速を **${speed}** に設定しました。`, flags: [MessageFlags.Ephemeral] });
    }
    
    else if (customId === 'config_pitch_modal_submit') {
        const input = interaction.fields.getTextInputValue('config_pitch_input');
        const pitch = parseFloat(input);

        if (isNaN(pitch) || pitch < -0.15 || pitch > 0.15) {
            await interaction.reply({ content: '❌ 無効な値です。-0.15 から 0.15 の間の数値を入力してください。', flags: [MessageFlags.Ephemeral] });
            return;
        }

        setUserPitch(guildId, interaction.user.id, pitch);

        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            manager.setPitch(interaction.user.id, pitch);
        }

        await interaction.reply({ content: `✅ あなたのピッチを **${pitch}** に設定しました。`, flags: [MessageFlags.Ephemeral] });
    }
};