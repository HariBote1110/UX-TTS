const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags, AttachmentBuilder } = require('discord.js');
const { OJT_SPEAKERS } = require('../../../utils/helpers');
const { 
    removeDictionaryEntry, 
    addIgnoreChannel, 
    removeIgnoreChannel,
    addAllowChannel,
    removeAllowChannel,
    setUserSpeakerId,
    addChannelPair,
    removeChannelPair,
    getGuildSettings,
    getDictionaryEntries
} = require('../../../database');

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    if (customId === 'dict_delete_menu_selected') {
        const selectedWords = interaction.values; 
        let deletedCount = 0;
        for (const word of selectedWords) {
            if (removeDictionaryEntry(guildId, word)) deletedCount++;
        }
        await interaction.update({ 
            content: `✅ **${deletedCount}** 件の単語を削除しました。`, 
            embeds: [], components: [] 
        });
    }
    // --- Ignore List ---
    else if (customId === 'autojoin_ignore_add_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if(addIgnoreChannel(guildId, id)) count++;
        }
        await interaction.update({ content: `✅ **${count}** 件のチャンネルを自動接続の除外対象に追加しました。`, components: [] });
    }
    else if (customId === 'autojoin_ignore_remove_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if(removeIgnoreChannel(guildId, id)) count++;
        }
        await interaction.update({ content: `✅ **${count}** 件のチャンネルを除外解除しました。`, components: [] });
    }

    // --- Allow List ---
    else if (customId === 'autojoin_allow_add_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if(addAllowChannel(guildId, id)) count++;
        }

        const settings = getGuildSettings(guildId);
        if (!settings.auto_join_enabled) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('autojoin_enable_confirm_yes').setLabel('はい (自動接続をONにする)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('autojoin_enable_confirm_no').setLabel('いいえ (OFFのまま)').setStyle(ButtonStyle.Secondary)
            );
            
            await interaction.update({ 
                content: `✅ **${count}** 件のチャンネルを許可リストに追加しました。\n\n⚠️ **現在、サーバー全体の自動接続設定が「OFF」になっています。**\nこのままでは自動接続されませんが、設定を「ON」に切り替えますか？`, 
                components: [row],
                embeds: [] 
            });
        } else {
            await interaction.update({ content: `✅ **${count}** 件のチャンネルを自動接続の許可対象に追加しました。\n(これ以降、許可リストにあるチャンネルのみ自動接続します)`, components: [] });
        }
    }
    else if (customId === 'autojoin_allow_remove_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if(removeAllowChannel(guildId, id)) count++;
        }
        await interaction.update({ content: `✅ **${count}** 件のチャンネルを許可解除しました。`, components: [] });
    }

    // ====================================================
    // ★ 辞書エクスポート形式選択
    // ====================================================
    else if (customId === 'dict_export_format_select') {
        const format = interaction.values[0];
        const entries = getDictionaryEntries(guildId);
        
        let buffer;
        let fileName;
        let message = '';

        if (format === 'uxtts') {
            // UX TTS形式 (JSON Array)
            const data = entries.map(e => ({ word: e.word, read: e.read_as }));
            const jsonStr = JSON.stringify(data, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_export.json';
            message = '✅ **UX TTS形式** でエクスポートしました。';
        } 
        else if (format === 'voiceroid') {
            // VOICEROID読み上げbotなどの形式 (JSON)
            const dataMap = {};
            entries.forEach(e => { dataMap[e.word] = e.read_as; });
            const exportObj = {
                kind: "com.kuroneko6423.kuronekottsbot.dictionary",
                version: 0,
                data: dataMap
            };
            const jsonStr = JSON.stringify(exportObj, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_voiceroid.json';
            message = '✅ **VOICEROID読み上げbotなどの形式** でエクスポートしました。';
        }
        else if (format === 'shovel') {
            // ★ 修正: Shovelなどの形式 (CSV/Dict, UTF-16LE with BOM)
            const csvLines = entries.map(e => `${e.word}, ${e.read_as}`);
            const csvStr = csvLines.join('\r\n'); // Windows改行コード推奨
            
            // BOM (FF FE) + UTF-16LEエンコード
            const bom = Buffer.from([0xFF, 0xFE]);
            const content = Buffer.from(csvStr, 'utf16le');
            buffer = Buffer.concat([bom, content]);
            
            fileName = 'dictionary.dict'; // 拡張子は .dict
            message = '✅ **Shovelなどの形式 (UTF-16LE)** でエクスポートしました。';
        }

        const attachment = new AttachmentBuilder(buffer, { name: fileName });
        await interaction.update({ 
            content: message, 
            files: [attachment], 
            embeds: [], 
            components: [] 
        });
    }

    // --- Speaker Selection ---
    else if (customId.startsWith('select_character_page_')) {
        const manager = client.guildVoiceManagers.get(guildId);
        const userId = interaction.user.id; 
        const parts = customId.split('_');
        const type = parts[5] || 'voicevox'; 
        const targetUserId = parts[4];
        
        if (userId !== targetUserId) return interaction.reply({ content: '他人の設定メニューは操作できません。', flags: [MessageFlags.Ephemeral] });

        const speakerUUID = interaction.values[0];
        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        const speaker = speakerList.find(s => s.speaker_uuid === speakerUUID);
        
        if (!speaker) return interaction.update({ content: 'エラー: 話者が見つかりません。', embeds: [], components: [] });

        if (speaker.styles.length === 1) {
            const style = speaker.styles[0];
            const confirmButton = new ButtonBuilder()
                .setCustomId(`confirm_style_${style.id}_${speaker.name}_${style.name}_${userId}_${type}`)
                .setLabel('✅ はい、この話者に設定する').setStyle(ButtonStyle.Success);
            const cancelButton = new ButtonBuilder()
                .setCustomId(`back_to_charlist_page_${parts[3]}_${userId}_${type}`)
                .setLabel('◀ いいえ (戻る)').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);
            await interaction.update({
                content: `**${speaker.name}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しますか？`,
                embeds: [], components: [row]
            });
        } else {
            const styleOptions = speaker.styles.map(style => ({ label: style.name, value: String(style.id) }));
            const styleSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select_style_${speaker.speaker_uuid}_${userId}_${type}`)
                .setPlaceholder(`${speaker.name} のスタイルを選択...`).addOptions(styleOptions);
            const menuRow = new ActionRowBuilder().addComponents(styleSelectMenu);
            const backButton = new ButtonBuilder()
                .setCustomId(`back_to_charlist_page_${parts[3]}_${userId}_${type}`)
                .setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary);
            const buttonRow = new ActionRowBuilder().addComponents(backButton);
            await interaction.update({
                content: `**${speaker.name}** のスタイルを選択してください。`,
                embeds: [], components: [menuRow, buttonRow] 
            });
        }
    }
    else if (customId.startsWith('select_style_')) {
        const manager = client.guildVoiceManagers.get(guildId);
        const userId = interaction.user.id; 
        const parts = customId.split('_');
        const type = parts[4] || 'voicevox';
        const targetUserId = parts[3];
        const speakerUUID = parts[2];

        if (userId !== targetUserId) return interaction.reply({ content: '他人の設定メニューは操作できません。', flags: [MessageFlags.Ephemeral] });
        if (!manager || !manager.isActive()) return interaction.update({ content: 'BotがVCに参加していません。', embeds: [], components: [] });

        const speakerId = parseInt(interaction.values[0], 10);
        setUserSpeakerId(guildId, userId, speakerId, type); 
        
        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        const speakerName = speakerList.find(s => s.speaker_uuid === speakerUUID)?.name || '不明';
        
        await interaction.update({
            content: `✅ あなたの話者を **${speakerName}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しました。`,
            embeds: [], components: [] 
        });
    }

    // --- Channel Pairing ---
    else if (customId === 'autojoin_pair_select_voice') {
        const voiceId = interaction.values[0];
        const select = new ChannelSelectMenuBuilder()
            .setCustomId(`autojoin_pair_select_text_${voiceId}`)
            .setPlaceholder('2. 紐付けるテキストチャンネルを選択')
            .addChannelTypes(ChannelType.GuildText)
            .setMinValues(1)
            .setMaxValues(1);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.update({ content: '次に、読み上げ対象とする **テキストチャンネル** を選択してください:', components: [row] });
    }
    else if (customId.startsWith('autojoin_pair_select_text_')) {
        const voiceId = customId.split('_')[4];
        const textId = interaction.values[0];
        addChannelPair(guildId, voiceId, textId);
        const vc = interaction.guild.channels.cache.get(voiceId);
        const tc = interaction.guild.channels.cache.get(textId);
        await interaction.update({ 
            content: `✅ 設定を保存しました。\n🔊 **${vc ? vc.name : '不明'}** に自動接続した際、📝 **${tc ? tc.name : '不明'}** を読み上げ対象にします。`, 
            components: [] 
        });
    }
    else if (customId === 'autojoin_pair_remove_submit') {
        const voiceId = interaction.values[0];
        removeChannelPair(guildId, voiceId);
        await interaction.update({ content: '✅ ペアリング設定を削除しました。', components: [] });
    }
};