const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { createAutojoinMenuPayload, createSpeakerUIPayload } = require('../../../../utils/helpers');
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
        const userSettings = getUserSettings(guildId, interaction.user.id);
        const type = userSettings.speaker_type || 'voicevox';
        // 話者設定UIを作成して表示 (ページ1)
        await interaction.reply(await createSpeakerUIPayload(client, 1, interaction.user.id, type));
        return true;
    }

    // 話速設定モーダルを開く
    if (customId === 'config_open_speed') {
        const userSettings = getUserSettings(guildId, interaction.user.id);
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
        const userSettings = getUserSettings(guildId, interaction.user.id);
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
        if (!isAdmin) return interaction.reply({ content: '❌ この設定を変更するには管理者権限が必要です。', flags: [MessageFlags.Ephemeral] });
        
        const settings = getGuildSettings(guildId);
        let newStatus;
        if (customId === 'config_toggle_join') {
            newStatus = !settings.read_join;
            setGuildReadJoin(guildId, newStatus);
        } else {
            newStatus = !settings.read_leave;
            setGuildReadLeave(guildId, newStatus);
        }
        
        // UI更新
        const newSettings = getGuildSettings(guildId);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fields = embed.data.fields || [];
        // 既存フィールドの更新 (インデックス0が入退室設定と仮定)
        if (fields.length > 0) {
            fields[0].value = `入室: **${newSettings.read_join ? 'ON' : 'OFF'}** / 退出: **${newSettings.read_leave ? 'ON' : 'OFF'}**`;
            embed.setFields(fields);
        }
        
        // ボタンの見た目更新 (Row 2にあると仮定して検索)
        const rows = interaction.message.components.map(r => ActionRowBuilder.from(r));
        // 入退室ボタンが含まれているRowを探す
        const targetRow = rows.find(row => row.components.some(c => c.data.custom_id === 'config_toggle_join'));
        
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
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions);
        await interaction.reply(payload);
        return true;
    }

    // --- 旧Configボタンの互換性維持 ---
    if (customId === 'config_toggle_autojoin_user') {
        const settings = getUserSettings(guildId, interaction.user.id);
        const newStatus = !settings.auto_join;
        setUserAutoJoin(guildId, interaction.user.id, newStatus);
        await interaction.reply({ content: `✅ 個人設定を ${newStatus ? 'ON' : 'OFF'} にしました。`, flags: [MessageFlags.Ephemeral] });
        return true;
    }
    if (customId === 'config_toggle_autojoin_server') {
        if (!isAdmin) return interaction.reply({ content: '❌ 管理者権限が必要です。', flags: [MessageFlags.Ephemeral] });
        const settings = getGuildSettings(guildId);
        const newStatus = !settings.auto_join_enabled;
        setGuildAutoJoin(guildId, newStatus);
        await interaction.reply({ content: `✅ サーバー設定を ${newStatus ? 'ON' : 'OFF'} にしました。`, flags: [MessageFlags.Ephemeral] });
        return true;
    }
    if (customId === 'config_open_ignore') {
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions);
        await interaction.reply(payload);
        return true;
    }

    // 辞書・ActiveSpeechメニュー呼び出し
    if (customId === 'config_open_dict') { 
        const cmd = client.commands.get('dictionary');
        if (cmd) await cmd.execute(interaction, client);
        else await interaction.reply({ content: '❌ 辞書コマンドが見つかりません。', flags: [MessageFlags.Ephemeral] });
        return true;
    }
    if (customId === 'config_open_activespeech') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('activespeech_enable').setLabel('有効にする').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('activespeech_disable').setLabel('無効にする').setStyle(ButtonStyle.Danger)
        );
        await interaction.reply({ content: 'ActiveSpeech機能の設定:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    return false;
};