const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { deactivateLicense } = require('../../database');

const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deactivate_license')
        .setDescription('このサーバーに適用されているライセンスを解除します。（管理者専用）'),
        
    async execute(interaction, client) {
        const { guildId } = interaction;
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isOwner = interaction.user.id === BOT_OWNER_ID;

        if (!isAdmin && !isOwner) {
            await interaction.reply({ content: '❌ このコマンドはサーバーの管理者のみが実行できます。', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        const result = deactivateLicense(guildId);
        
        const embed = new EmbedBuilder()
            .setTitle(result.success ? '✅ ライセンス解除' : 'ℹ️ ライセンス解除')
            .setDescription(result.message)
            .setColor(result.success ? 0x00FF00 : 0xAAAAAA); 
            
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
};