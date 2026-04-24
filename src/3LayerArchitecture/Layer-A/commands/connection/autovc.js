const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { createAutoVCMenuPayload } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autovc')
        .setDescription('自動VC作成機能の設定メニューを開きます。')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const payload = await createAutoVCMenuPayload(
            interaction.guild,
            interaction.user.id,
            interaction.member.permissions
        );
        await interaction.reply(payload);
    },
};
