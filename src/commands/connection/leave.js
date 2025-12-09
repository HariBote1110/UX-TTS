const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { updateActivity } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Botをボイスチャンネルから切断します。'),
        
    async execute(interaction, client) {
        // ★ 応答期限切れを防ぐため、deferReplyを使用
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const { guildId } = interaction;
        const manager = client.guildVoiceManagers.get(guildId);

        if (!manager || !manager.isActive()) {
            return interaction.editReply({ content: 'VCに参加していません。' });
        }

        manager.disconnect(false); 
        await interaction.editReply({ content: '👋 VCから切断しました。' });
        // managerDestroyedイベント経由でupdateActivityが呼ばれる
    },
};