const handleConfig = require('./buttons/handleConfig');
const handleAutojoin = require('./buttons/handleAutojoin');
const handleCommon = require('./buttons/handleCommon');

module.exports = async (interaction, client) => {
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

    // 3. その他（辞書、ActiveSpeech、Speaker）のボタンかチェック
    await handleCommon(interaction, client);
};