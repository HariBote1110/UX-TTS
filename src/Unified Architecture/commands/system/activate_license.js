const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { activateLicense } = require('../../database');

const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('activate_license')
        .setDescription('サーバーにライセンスキーを適用します。（管理者専用）')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('発行されたライセンスキー')
                .setRequired(true)),
        
    async execute(interaction, client) {
        const { guildId } = interaction;
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isOwner = interaction.user.id === BOT_OWNER_ID; 

        if (!isAdmin && !isOwner) {
            await interaction.reply({ content: '❌ このコマンドはサーバーの管理者のみが実行できます。', flags: [MessageFlags.Ephemeral] });
            return;
        }

        const key = interaction.options.getString('key');
        const result = activateLicense(key, guildId);

        const embed = new EmbedBuilder()
            .setTitle(result.success ? '✅ ライセンス適用' : '❌ ライセンス適用失敗')
            .setDescription(result.message)
            .setColor(result.success ? 0xFFD700 : 0xFF0000); 
            
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
};