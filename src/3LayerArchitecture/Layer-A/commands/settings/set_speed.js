const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createStatusMessage } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_speed')
        .setDescription('あなたの読み上げ速度を設定します。（VOICEVOX専用）')
        .addNumberOption(option => 
            option.setName('value')
                .setDescription('速度 (0.5 から 2.0 まで、デフォルト 1.0)')
                .setMinValue(0.5)
                .setMaxValue(2.0)
                .setRequired(true)),
        
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

        const speed = interaction.options.getNumber('value');
        manager.setSpeed(interaction.user.id, speed); 
        
        await interaction.reply(createStatusMessage(
            'success',
            `あなたの話速を **${speed}** に設定しました。`,
            { flags: [MessageFlags.Ephemeral] }
        ));
    },
};
