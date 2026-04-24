const { SlashCommandBuilder } = require('discord.js');
const { updateActivity, createStatusMessage } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Botをボイスチャンネルから切断します。'),

    async execute(interaction, client) {
        await interaction.deferReply();

        const { guildId } = interaction;
        const manager = client.guildVoiceManagers.get(guildId);

        if (!manager || !manager.isActive()) {
            return interaction.editReply(createStatusMessage('warning', 'VCに参加していません。'));
        }

        const sessionChars = manager.getSessionCharCount();
        manager.disconnect(false);

        let description = 'VCから切断しました。';
        if (sessionChars > 0) {
            description += `\n📊 このセッションで読み上げた文字数: **${sessionChars.toLocaleString()}** 文字`;
        }

        await interaction.editReply(createStatusMessage('success', description, { title: '👋 切断完了' }));
        await updateActivity(client);
    },
};
