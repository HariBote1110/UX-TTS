const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createConfigMenuPayload } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Botの全体設定メニューを開きます。'),

    async execute(interaction, client) {
        const payload = await createConfigMenuPayload(interaction.guildId, interaction.member);
        await interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] });
    },
};
