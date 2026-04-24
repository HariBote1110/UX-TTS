const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, MessageFlags } = require('discord.js');
const { getGuildSettings, getIgnoreChannels, getUserSettings } = require('../../database');
const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Botの全体設定メニューを開きます。'),

    async execute(interaction, client) {
        const { guildId, user } = interaction;
        
        // 権限チェック
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator) || user.id === BOT_OWNER_ID;

        // 各種設定の取得
        const guildSettings = getGuildSettings(guildId);
        const userSettings = getUserSettings(guildId, user.id);

        // --- Embed作成 ---
        const embed = new EmbedBuilder()
            .setTitle('⚙️ 設定メニュー (Config)')
            .setDescription('以下のボタンから各設定を行えます。')
            .setColor(0x5865F2);

        // 1. 入退室読み上げ
        embed.addFields({ 
            name: '📢 入退室読み上げ (サーバー全体)', 
            value: `入室: **${guildSettings.read_join ? 'ON' : 'OFF'}** / 退出: **${guildSettings.read_leave ? 'ON' : 'OFF'}**`, 
            inline: false 
        });

        // 2. 自動接続
        embed.addFields({ 
            name: '🤖 自動接続', 
            value: '詳細設定は下のボタンからメニューを開いてください。', 
            inline: false 
        });

        // 3. 音声設定 (★ 追加)
        const speed = userSettings.speed || 1.0;
        const pitch = userSettings.pitch || 0.0;
        embed.addFields({
            name: '🗣️ 音声設定 (個人)',
            value: `話速: **${speed.toFixed(1)}** / ピッチ: **${pitch.toFixed(2)}**`,
            inline: false
        });

        // --- ボタン作成 ---
        
        // Row 1: 音声設定 (★ 新規追加)
        const rowVoice = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('config_open_speaker').setLabel('話者を変更').setStyle(ButtonStyle.Success).setEmoji('🗣️'),
                new ButtonBuilder().setCustomId('config_open_speed').setLabel('話速設定').setStyle(ButtonStyle.Secondary).setEmoji('⏩'),
                new ButtonBuilder().setCustomId('config_open_pitch').setLabel('ピッチ設定').setStyle(ButtonStyle.Secondary).setEmoji('🎚️')
            );

        // Row 2: 入退室読み上げ
        const rowJoinLeave = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('config_toggle_join')
                    .setLabel(`入室読み上げ: ${guildSettings.read_join ? 'ON' : 'OFF'}`)
                    .setStyle(guildSettings.read_join ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setEmoji('👋')
                    .setDisabled(!isAdmin), 
                new ButtonBuilder()
                    .setCustomId('config_toggle_leave')
                    .setLabel(`退出読み上げ: ${guildSettings.read_leave ? 'ON' : 'OFF'}`)
                    .setStyle(guildSettings.read_leave ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setEmoji('🚪')
                    .setDisabled(!isAdmin)
            );

        // Row 3: 自動接続
        const rowAutoJoin = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('config_open_autojoin')
                    .setLabel('自動接続・追従設定を開く')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🤖')
            );

        // Row 4: その他
        const rowOther = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('config_open_dict').setLabel('辞書設定').setStyle(ButtonStyle.Primary).setEmoji('📖'),
                new ButtonBuilder().setCustomId('config_open_activespeech').setLabel('ActiveSpeech').setStyle(ButtonStyle.Primary).setEmoji('🎙️')
            );

        const components = [rowVoice, rowJoinLeave, rowAutoJoin, rowOther];
        await interaction.reply({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] });
    },
};