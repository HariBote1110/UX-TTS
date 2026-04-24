const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { createAutojoinMenuPayload, createAutoVCMenuPayload, createSpeakerUIPayload, createStatusMessage, createActiveSpeechPanelPayload, createConfigMenuPayload } = require('../../../../utils/helpers');
const {
    getGuildSettings, getUserSettings, setGuildReadJoin, setGuildReadLeave, setUserAutoJoin, setGuildAutoJoin
} = require('../../../../database');

const { BOT_OWNER_ID } = process.env;

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || interaction.user.id === BOT_OWNER_ID;

    // ====================================================
    // ★ 音声設定 (Voice Settings)
    // ====================================================

    // 話者設定メニューを開く
    if (customId === 'config_open_speaker') {
        const userSettings = await getUserSettings(guildId, interaction.user.id);
        const type = userSettings.speaker_type || 'voicevox';
        await interaction.update(await createSpeakerUIPayload(client, 1, interaction.user.id, type, interaction.member, 'user', true));
        return true;
    }

    // 話速設定モーダルを開く
    if (customId === 'config_open_speed') {
        const userSettings = await getUserSettings(guildId, interaction.user.id);
        const currentSpeed = userSettings.speed || 1.0;

        const modal = new ModalBuilder().setCustomId('config_speed_modal_submit').setTitle('話速 (Speed) の設定');
        const input = new TextInputBuilder()
            .setCustomId('config_speed_input')
            .setLabel("速度を入力 (0.5 ～ 2.0)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 1.2')
            .setValue(String(currentSpeed)) // 現在値を初期入力
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
    }

    // ピッチ設定モーダルを開く
    if (customId === 'config_open_pitch') {
        const userSettings = await getUserSettings(guildId, interaction.user.id);
        const currentPitch = userSettings.pitch || 0.0;

        const modal = new ModalBuilder().setCustomId('config_pitch_modal_submit').setTitle('ピッチ (Pitch) の設定');
        const input = new TextInputBuilder()
            .setCustomId('config_pitch_input')
            .setLabel("高さを入力 (-0.15 ～ 0.15)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例: 0.05')
            .setValue(String(currentPitch))
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
    }


    // ====================================================
    // 入退室読み上げ設定
    // ====================================================
    if (customId === 'config_toggle_join' || customId === 'config_toggle_leave') {
        if (!isAdmin) return interaction.reply(createStatusMessage('error', 'この設定を変更するには管理者権限が必要です。', { flags: [MessageFlags.Ephemeral] }));

        const settings = await getGuildSettings(guildId);
        let newStatus;
        if (customId === 'config_toggle_join') {
            newStatus = !settings.read_join;
            await setGuildReadJoin(guildId, newStatus);
        } else {
            newStatus = !settings.read_leave;
            await setGuildReadLeave(guildId, newStatus);
        }

        // UI更新
        const newSettings = await getGuildSettings(guildId);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fields = embed.data.fields || [];
        // 入退室設定フィールドをフィールド名で特定して更新
        const targetField = fields.find(f => f.name && f.name.includes('入退室'));
        if (targetField) {
            targetField.value = `入室: **${newSettings.read_join ? 'ON' : 'OFF'}** / 退出: **${newSettings.read_leave ? 'ON' : 'OFF'}**`;
            embed.setFields(fields);
        }

        // 入退室ボタンが含まれているRowを探す (公開 API の customId を使用)
        const rows = interaction.message.components.map(r => ActionRowBuilder.from(r));
        const targetRow = rows.find(row => row.components.some(c => (c.data?.custom_id ?? c.customId) === 'config_toggle_join'));

        if (targetRow) {
            const btnIndex = customId === 'config_toggle_join' ? 0 : 1;
            targetRow.components[btnIndex].setLabel(`${customId === 'config_toggle_join' ? '入室' : '退出'}読み上げ: ${newStatus ? 'ON' : 'OFF'}`);
            targetRow.components[btnIndex].setStyle(newStatus ? ButtonStyle.Success : ButtonStyle.Secondary);
        }

        await interaction.update({ embeds: [embed], components: rows });
        return true;
    }

    // 自動接続メニューを開く
    if (customId === 'config_open_autojoin') {
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: true });
        await interaction.update(payload);
        return true;
    }

    if (customId === 'config_open_autovc') {
        const payload = await createAutoVCMenuPayload(interaction.guild, interaction.user.id, interaction.member.permissions, { showBack: true });
        await interaction.update(payload);
        return true;
    }

    // --- 旧Configボタンの互換性維持 ---
    if (customId === 'config_toggle_autojoin_user') {
        const settings = await getUserSettings(guildId, interaction.user.id);
        const newStatus = !settings.auto_join;
        await setUserAutoJoin(guildId, interaction.user.id, newStatus);
        await interaction.reply(createStatusMessage('success', `個人設定を ${newStatus ? 'ON' : 'OFF'} にしました。`, { flags: [MessageFlags.Ephemeral] }));
        return true;
    }
    if (customId === 'config_toggle_autojoin_server') {
        if (!isAdmin) return interaction.reply(createStatusMessage('error', '管理者権限が必要です。', { flags: [MessageFlags.Ephemeral] }));
        const settings = await getGuildSettings(guildId);
        const newStatus = !settings.auto_join_enabled;
        await setGuildAutoJoin(guildId, newStatus);
        await interaction.reply(createStatusMessage('success', `サーバー設定を ${newStatus ? 'ON' : 'OFF'} にしました。`, { flags: [MessageFlags.Ephemeral] }));
        return true;
    }
    if (customId === 'config_open_ignore') {
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: true });
        await interaction.update(payload);
        return true;
    }

    // 辞書メニュー呼び出し (update で既存メッセージを差し替え)
    if (customId === 'config_open_dict') {
        const dictEmbed = new EmbedBuilder()
            .setTitle('📖 辞書設定')
            .setDescription('上段・中段は**サーバー共有辞書**、下段は**マイ辞書**（あなたの発言のみ・最大10語）です。')
            .setColor(0x00AAFF);
        const dictRow1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dict_add_modal_open').setLabel('登録 / 編集').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('dict_delete_menu_open').setLabel('選択して削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('dict_delete_modal_open').setLabel('入力して削除').setStyle(ButtonStyle.Secondary).setEmoji('⌨️'),
            new ButtonBuilder().setCustomId('dict_list_show').setLabel('一覧を表示').setStyle(ButtonStyle.Primary).setEmoji('📄')
        );
        const dictRow2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dict_export_file').setLabel('エクスポート').setStyle(ButtonStyle.Secondary).setEmoji('📤'),
            new ButtonBuilder().setCustomId('dict_import_start').setLabel('インポート').setStyle(ButtonStyle.Secondary).setEmoji('📥')
        );
        const dictRowMy = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('user_dict_add_modal_open').setLabel('マイ辞書 登録').setStyle(ButtonStyle.Success).setEmoji('🔖'),
            new ButtonBuilder().setCustomId('user_dict_delete_menu_open').setLabel('マイ辞書 選択削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('user_dict_delete_modal_open').setLabel('マイ辞書 入力削除').setStyle(ButtonStyle.Secondary).setEmoji('⌨️'),
            new ButtonBuilder().setCustomId('user_dict_list_show').setLabel('マイ辞書 一覧').setStyle(ButtonStyle.Primary).setEmoji('📋')
        );
        const dictRowBack = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)
        );
        await interaction.update({ embeds: [dictEmbed], components: [dictRow1, dictRow2, dictRowMy, dictRowBack] });
        return true;
    }

    if (customId === 'config_open_activespeech') {
        const userSettings = await getUserSettings(guildId, interaction.user.id);
        const isEnabled = userSettings.active_speech === 1;
        await interaction.update(createActiveSpeechPanelPayload(isEnabled, { showBack: true }));
        return true;
    }

    if (customId === 'config_back_main') {
        const payload = await createConfigMenuPayload(guildId, interaction.member);
        await interaction.update(payload);
        return true;
    }

    return false;
};
