const { SlashCommandBuilder } = require('discord.js');
const { createAutojoinMenuPayload } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autojoin') // ★ここが 'autovc' になっているとエラーになります
        .setDescription('自動接続（追従）機能の設定メニューを開きます。'),

    async execute(interaction, client) {
        const { guildId, user, member } = interaction;
        
        // メニューPayloadを生成して表示
        const payload = await createAutojoinMenuPayload(guildId, user.id, member.permissions);
        await interaction.reply(payload);
    },
};