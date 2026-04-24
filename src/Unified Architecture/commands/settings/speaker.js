const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createSpeakerUIPayload } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speaker')
        .setDescription('あなたの読み上げ話者を設定します。'),
        
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

        // デフォルトは VOICEVOX ('voicevox') を表示
        await interaction.reply(await createSpeakerUIPayload(client, 1, interaction.user.id, 'voicevox'));
    },
};