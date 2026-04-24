const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { createStatusMessage } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reset_settings')
        .setDescription('あなたの話者・話速・ピッチ設定をデフォルトに戻します。'),

    async execute(interaction, client) {
        const { guildId } = interaction;
        const manager = client.guildVoiceManagers.get(guildId);

        if (!manager || !manager.isActive()) {
            await interaction.reply(createStatusMessage(
                'warning',
                'このコマンドは、まず `/join` でBotをボイスチャンネルに参加させてから使用してください。',
                { flags: [MessageFlags.Ephemeral] }
            ));
            return;
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reset_settings_confirm_yes')
                .setLabel('はい、リセットする')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('reset_settings_confirm_no')
                .setLabel('キャンセル')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply(createStatusMessage(
            'warning',
            '本当に話者・話速・ピッチ設定をデフォルトに戻しますか？\nこの操作は取り消せません。',
            { title: '⚠️ リセットの確認', components: [row], flags: [MessageFlags.Ephemeral] }
        ));
    },
};
