const { Events, MessageFlags } = require('discord.js');
const { sendErrorLog } = require('../../errorLogger');
const { createStatusMessage } = require('../../utils/helpers');

// ハンドラーの読み込み
const handleCommands = require('./handlers/handleCommands');
const handleButtons = require('./handlers/handleButtons');
const handleSelectMenus = require('./handlers/handleSelectMenus');
const handleModals = require('./handlers/handleModals');
const handleAutoVC = require('./handlers/handleAutoVC');

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
                // ★ AutoVC用のルーティング
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleButton(interaction);
                    return;
                }
                await handleButtons(interaction, client);
            }
            // --- C. メニュー処理 ---
            // 修正: isAnySelectMenu() を使用して、ユーザー選択メニュー(UserSelectMenu)なども含める
            else if (interaction.isAnySelectMenu()) {
                // ★ AutoVC用のルーティング
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleSelect(interaction);
                    return;
                }
                await handleSelectMenus(interaction, client);
            }
            // --- D. モーダル送信 ---
            else if (interaction.isModalSubmit()) {
                // ★ AutoVC用のルーティング
                if (interaction.customId.startsWith('autovc_')) {
                    await handleAutoVC.handleModal(interaction);
                    return;
                }
                await handleModals(interaction, client);
            }

        } catch (error) {
            console.error(`Interaction Error:`, error);
            
            if (!interaction.replied && !interaction.deferred) {
                const replyContent = createStatusMessage('error', 'エラーが発生しました。', { flags: [MessageFlags.Ephemeral] });
                await interaction.reply(replyContent).catch(() => {});
            }
            sendErrorLog(client, error, { place: 'InteractionCreate', guildId: interaction.guildId });
        }
    },
};
