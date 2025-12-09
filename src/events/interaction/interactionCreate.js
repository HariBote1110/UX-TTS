const { Events, MessageFlags } = require('discord.js');
const { sendErrorLog } = require('../../errorLogger');

// ハンドラーの読み込み
const handleCommands = require('./handlers/handleCommands');
const handleButtons = require('./handlers/handleButtons');
const handleSelectMenus = require('./handlers/handleSelectMenus');
const handleModals = require('./handlers/handleModals');
const handleAutoVC = require('./handlers/handleAutoVC'); // ★ AutoVCハンドラ追加

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction, client) {
        if (!interaction.guildId) return;

        try {
            // --- A. スラッシュコマンド ---
            if (interaction.isChatInputCommand()) {
                await handleCommands(interaction, client);
            }
            // --- B. ボタン処理 ---
            else if (interaction.isButton()) {
                // ★ AutoVC用のルーティング追加
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleButton(interaction);
                    return;
                }
                await handleButtons(interaction, client);
            }
            // --- C. メニュー処理 ---
            else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
                // ★ AutoVC用のルーティング追加
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleSelect(interaction);
                    return;
                }
                await handleSelectMenus(interaction, client);
            }
            // --- D. モーダル送信 ---
            else if (interaction.isModalSubmit()) {
                // ★ AutoVC用のルーティング追加
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleModal(interaction);
                    return;
                }
                await handleModals(interaction, client);
            }

        } catch (error) {
            console.error(`Interaction Error:`, error);
            if (!interaction.replied && !interaction.deferred) {
                const replyContent = { content: '❌ エラーが発生しました。', flags: [MessageFlags.Ephemeral] };
                await interaction.reply(replyContent).catch(() => {});
            }
            sendErrorLog(client, error, { place: 'InteractionCreate', guildId: interaction.guildId });
        }
    },
};