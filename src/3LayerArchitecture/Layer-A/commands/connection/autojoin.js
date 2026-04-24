const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { createAutojoinMenuPayload } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autojoin')
        .setDescription('自動接続とチャンネルペアリング設定の管理パネルを開きます')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        // ヘルパー関数を使用してメインメニューのパネル（Embed + Button）を生成
        const payload = await createAutojoinMenuPayload(
            interaction.guild.id, 
            interaction.user.id, 
            interaction.member.permissions
        );
        
        // パネルを表示 (Ephemeralで他者に見えないようにする)
        await interaction.reply({ ...payload, ephemeral: true });
    },
};