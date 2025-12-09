const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reset_settings')
        .setDescription('あなたの話者・話速・ピッチ設定をデフォルトに戻します。'),
        
    async execute(interaction, client) {
        const { guildId } = interaction;
        const manager = client.guildVoiceManagers.get(guildId);

        if (!manager || !manager.isActive()) {
            await interaction.reply({ 
                content: 'このコマンドは、まず `/join` でBotをボイスチャンネルに参加させてから使用してください。', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        manager.resetSettings(interaction.user.id); 
        
        await interaction.reply({
            content: `✅ あなたの話者・話速・ピッチをデフォルトに戻しました。`,
            flags: [MessageFlags.Ephemeral]
        });
    },
};