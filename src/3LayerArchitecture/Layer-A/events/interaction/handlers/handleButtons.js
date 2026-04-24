const handleConfig = require('./buttons/handleConfig');
const handleAutojoin = require('./buttons/handleAutojoin');
const handleJoinOptions = require('./buttons/handleJoinOptions');
const handleCommon = require('./buttons/handleCommon');
const handleFeedback = require('./buttons/handleFeedback');
const handleUsage = require('./buttons/handleUsage');

module.exports = async (interaction, client) => {
    // 0. フィードバックボタン
    if (interaction.customId.startsWith('feedback:')) {
        const processed = await handleFeedback(interaction, client);
        if (processed) return;
    }

    // 0b. 使用量パネルのボタン
    if (interaction.customId.startsWith('usage:')) {
        const processed = await handleUsage(interaction, client);
        if (processed) return;
    }

    // 1. Config関連のボタンかチェック
    if (interaction.customId.startsWith('config_')) {
        const processed = await handleConfig(interaction, client);
        if (processed) return;
    }

    // 2. 自動接続関連のボタンかチェック
    if (interaction.customId.startsWith('autojoin_')) {
        const processed = await handleAutojoin(interaction, client);
        if (processed) return;
    }

    // 3. joinオプションのボタンかチェック
    if (interaction.customId.startsWith('joinopt:')) {
        const processed = await handleJoinOptions(interaction, client);
        if (processed) return;
    }

    // 4. その他（辞書、ActiveSpeech、Speaker）のボタンかチェック
    await handleCommon(interaction, client);
};
