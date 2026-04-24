const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { OJT_SPEAKERS, createSpeakerUIPayload, createStatusMessage } = require('../../../utils/helpers');
const {
    removeDictionaryEntry,
    removeUserPersonalDictionaryEntryById,
    addIgnoreChannel,
    removeIgnoreChannel,
    addAllowChannel,
    removeAllowChannel,
    setUserSpeakerId,
    setGuildDefaultSpeaker,
    addChannelPair,
    removeChannelPair,
    getGuildSettings,
    getDictionaryEntries
} = require('../../../database');

const { BOT_OWNER_ID } = process.env;

function parseSpeakerTargetToken(token) {
    const [scope, id] = String(token || '').split(':');
    if ((scope === 'user' || scope === 'guild') && id) {
        return { scope, id };
    }
    return { scope: 'user', id: String(token || '') };
}

function canEditSpeakerTarget(interaction, target) {
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || interaction.user.id === BOT_OWNER_ID;
    if (target.scope === 'guild') return isAdmin;
    return target.id === interaction.user.id || isAdmin;
}

function describeSpeakerTarget(target) {
    return target.scope === 'guild' ? 'サーバー既定話者' : `<@${target.id}>`;
}

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    if (customId === 'dict_delete_menu_selected') {
        const selectedWords = interaction.values;
        let deletedCount = 0;
        for (const word of selectedWords) {
            if (await removeDictionaryEntry(guildId, word)) deletedCount++;
        }
        await interaction.update(createStatusMessage('success', `**${deletedCount}** 件の単語を削除しました。`, { components: [] }));
    }
    else if (customId === 'user_dict_delete_menu_selected') {
        const userId = interaction.user.id;
        let deletedCount = 0;
        for (const idStr of interaction.values) {
            const id = parseInt(idStr, 10);
            if (!Number.isNaN(id) && (await removeUserPersonalDictionaryEntryById(userId, id))) deletedCount++;
        }
        await interaction.update(createStatusMessage('success', `**${deletedCount}** 件の単語を削除しました。`, { components: [] }));
    }
    // --- Ignore List ---
    else if (customId === 'autojoin_ignore_add_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if (await addIgnoreChannel(guildId, id)) count++;
        }
        await interaction.update(createStatusMessage('success', `**${count}** 件のチャンネルを自動接続の除外対象に追加しました。`, { components: [] }));
    }
    else if (customId === 'autojoin_ignore_remove_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if (await removeIgnoreChannel(guildId, id)) count++;
        }
        await interaction.update(createStatusMessage('success', `**${count}** 件のチャンネルを除外解除しました。`, { components: [] }));
    }

    // --- Allow List ---
    else if (customId === 'autojoin_allow_add_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if (await addAllowChannel(guildId, id)) count++;
        }

        const settings = await getGuildSettings(guildId);
        if (!settings.auto_join_enabled) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('autojoin_enable_confirm_yes').setLabel('はい (自動接続をONにする)').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('autojoin_enable_confirm_no').setLabel('いいえ (OFFのまま)').setStyle(ButtonStyle.Secondary)
            );

            await interaction.update(createStatusMessage(
                'warning',
                `**${count}** 件のチャンネルを許可リストに追加しました。\n\n**現在、サーバー全体の自動接続設定が「OFF」になっています。**\nこのままでは自動接続されませんが、設定を「ON」に切り替えますか？`,
                { title: '⚠️ 追加完了 / 確認が必要です', components: [row] }
            ));
        } else {
            await interaction.update(createStatusMessage('success', `**${count}** 件のチャンネルを自動接続の許可対象に追加しました。\n(これ以降、許可リストにあるチャンネルのみ自動接続します)`, { components: [] }));
        }
    }
    else if (customId === 'autojoin_allow_remove_submit') {
        const selectedIds = interaction.values;
        let count = 0;
        for (const id of selectedIds) {
            if (await removeAllowChannel(guildId, id)) count++;
        }
        await interaction.update(createStatusMessage('success', `**${count}** 件のチャンネルを許可解除しました。`, { components: [] }));
    }

    // ====================================================
    // 辞書エクスポート
    // ====================================================
    else if (customId === 'dict_export_format_select') {
        const format = interaction.values[0];
        const entries = await getDictionaryEntries(guildId);

        let buffer;
        let fileName;
        let message = '';

        if (format === 'uxtts') {
            const data = entries.map(e => ({ word: e.word, read: e.read_as }));
            const jsonStr = JSON.stringify(data, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_export.json';
            message = '✅ **UX TTS形式** でエクスポートしました。';
        }
        else if (format === 'voiceroid') {
            const dataMap = {};
            entries.forEach(e => { dataMap[e.word] = e.read_as; });
            const exportObj = { kind: "com.kuroneko6423.kuronekottsbot.dictionary", version: 0, data: dataMap };
            const jsonStr = JSON.stringify(exportObj, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_voiceroid.json';
            message = '✅ **VOICEROID読み上げbotなどの形式** でエクスポートしました。';
        }
        else if (format === 'shovel') {
            const csvLines = entries.map(e => `${e.word}, ${e.read_as}`);
            const csvStr = csvLines.join('\r\n');
            const bom = Buffer.from([0xFF, 0xFE]);
            const content = Buffer.from(csvStr, 'utf16le');
            buffer = Buffer.concat([bom, content]);
            fileName = 'dictionary.dict';
            message = '✅ **Shovelなどの形式 (UTF-16LE)** でエクスポートしました。';
        }

        const attachment = new AttachmentBuilder(buffer, { name: fileName });
        await interaction.update(createStatusMessage('success', message.replace(/^✅\s*/, ''), { files: [attachment], components: [] }));
    }

    // ====================================================
    // ★追加: ユーザー選択メニュー (管理者用)
    // ====================================================
    // 修正: IDパターンの揺れに対応するため startsWith('speaker_user_select') に変更
    else if (customId.startsWith('speaker_user_select')) {
        // 修正: まず応答を保留してタイムアウト(3秒ルール)を回避
        await interaction.deferUpdate();

        try {
            const parts = customId.split('_');
            const type = parts[3] || 'voicevox';
            const targetUserId = interaction.values[0]; // 選択されたユーザーID

            // メニューを再生成して更新 (ターゲットユーザーを変更)
            // 修正: deferUpdate後は update ではなく editReply を使用
            await interaction.editReply(await createSpeakerUIPayload(client, 1, targetUserId, type, interaction.member, 'user'));
        } catch (error) {
            console.error('Speaker user select error:', error);
            // エラー時はフォローアップで通知
            await interaction.followUp(createStatusMessage('error', '設定の読み込み中にエラーが発生しました。', { flags: [MessageFlags.Ephemeral] }));
        }
    }

    // --- Speaker Selection ---
    else if (customId.startsWith('select_character_page_')) {
        const parts = customId.split('_');
        const type = parts[5] || 'voicevox';
        const targetToken = parts[4];
        const target = parseSpeakerTargetToken(targetToken);

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定メニューを操作する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        const speakerUUID = interaction.values[0];
        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        const speaker = speakerList.find(s => s.speaker_uuid === speakerUUID);

        if (!speaker) return interaction.update(createStatusMessage('error', '話者が見つかりません。', { components: [] }));

        if (speaker.styles.length === 1) {
            const style = speaker.styles[0];
            const confirmButton = new ButtonBuilder()
                .setCustomId(`confirm_style_${style.id}_${targetToken}_${type}`)
                .setLabel('✅ はい、この話者に設定する').setStyle(ButtonStyle.Success);
            const cancelButton = new ButtonBuilder()
                .setCustomId(`back_to_charlist_page_${parts[3]}_${targetToken}_${type}`)
                .setLabel('◀ いいえ (戻る)').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);
            await interaction.update(createStatusMessage(
                'info',
                `**${speaker.name}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しますか？`,
                { title: '🎙️ 話者設定の確認', components: [row] }
            ));
        } else {
            const styleOptions = speaker.styles.map(style => ({ label: style.name, value: String(style.id) }));
            const styleSelectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select_style_${speaker.speaker_uuid}_${targetToken}_${type}`)
                .setPlaceholder(`${speaker.name} のスタイルを選択...`).addOptions(styleOptions);
            const menuRow = new ActionRowBuilder().addComponents(styleSelectMenu);
            const backButton = new ButtonBuilder()
                .setCustomId(`back_to_charlist_page_${parts[3]}_${targetToken}_${type}`)
                .setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary);
            const buttonRow = new ActionRowBuilder().addComponents(backButton);
            await interaction.update(createStatusMessage(
                'info',
                `**${speaker.name}** のスタイルを選択してください。`,
                { title: '🎚️ スタイル選択', components: [menuRow, buttonRow] }
            ));
        }
    }
    else if (customId.startsWith('select_style_')) {
        const parts = customId.split('_');
        const type = parts[4] || 'voicevox';
        const targetToken = parts[3];
        const target = parseSpeakerTargetToken(targetToken);
        const speakerUUID = parts[2];

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定メニューを操作する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        const speakerId = parseInt(interaction.values[0], 10);
        if (target.scope === 'guild') {
            await setGuildDefaultSpeaker(guildId, speakerId, type);
        } else {
            await setUserSpeakerId(guildId, target.id, speakerId, type);
        }

        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        const speakerName = speakerList.find(s => s.speaker_uuid === speakerUUID)?.name || '不明';
        const targetLabel = describeSpeakerTarget(target);

        await interaction.update(createStatusMessage('success', `${targetLabel} を **${speakerName}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しました。`, { components: [] }));
    }

    // --- Channel Pairing ---
    else if (customId === 'autojoin_pair_select_voice') {
        const voiceId = interaction.values[0];
        const select = new ChannelSelectMenuBuilder()
            .setCustomId(`autojoin_pair_select_text_${voiceId}`)
            .setPlaceholder('読み上げ先のテキストチャンネルを選択')
            .addChannelTypes(ChannelType.GuildText)
            .setMinValues(1).setMaxValues(1);
        const btnUseSelf = new ButtonBuilder()
            .setCustomId(`autojoin_pair_use_self_${voiceId}`)
            .setLabel('このVCのチャットを使用')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💬');
        const rowSelect = new ActionRowBuilder().addComponents(select);
        const rowBtn = new ActionRowBuilder().addComponents(btnUseSelf);
        await interaction.update(createStatusMessage(
            'info',
            '読み上げ先の **テキストチャンネル** を選択するか、下のボタンで **VC内チャット** を指定してください。',
            { components: [rowSelect, rowBtn] }
        ));
    }
    else if (customId.startsWith('autojoin_pair_select_text_')) {
        const voiceId = customId.split('_')[4];
        const textId = interaction.values[0];
        await addChannelPair(guildId, voiceId, textId);
        const vc = interaction.guild.channels.cache.get(voiceId);
        const tc = interaction.guild.channels.cache.get(textId);
        await interaction.update(createStatusMessage('success', `設定を保存しました。\n🔊 **${vc ? vc.name : '不明'}** に自動接続した際、📝 **${tc ? tc.name : '不明'}** を読み上げ対象にします。`, { components: [] }));
    }
    else if (customId === 'autojoin_pair_remove_submit') {
        const voiceId = interaction.values[0];
        await removeChannelPair(guildId, voiceId);
        await interaction.update(createStatusMessage('success', 'ペアリング設定を削除しました。', { components: [] }));
    }
};
