const { EmbedBuilder } = require('discord.js');

const COOLDOWN_MS = 60_000;
const guildLastNotifyMs = new Map();

/**
 * Notify the bound TTS text channel when the guild has exceeded its monthly character limit.
 * Cooldown avoids spam when many messages arrive in a short time.
 *
 * @param {import('discord.js').Client} client
 * @param {string|null|undefined} channelId
 * @param {string} guildId
 * @param {{ now?: number }} [opts] — `now` is for tests only (injected clock)
 * @returns {Promise<void>}
 */
async function notifyCharLimitExceeded(client, channelId, guildId, opts = {}) {
    if (!client || !channelId || !guildId) return;

    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const last = guildLastNotifyMs.get(guildId);
    if (last !== undefined && now - last < COOLDOWN_MS) return;

    guildLastNotifyMs.set(guildId, now);

    const ch = client.channels.cache.get(channelId);
    if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased()) return;

    const embed = new EmbedBuilder()
        .setTitle('⚠️ 読み上げ制限')
        .setDescription(
            '今月の読み上げ文字数上限に達しているため、このメッセージは読み上げられませんでした。\n' +
                '`/usage` で利用状況を確認するか、ライセンスのご利用・翌月までお待ちください。'
        )
        .setColor(0xFEE75C);

    await ch.send({ embeds: [embed] }).catch(() => {});
}

/** @internal Used by tests only */
function __resetLimitNotifyStateForTests() {
    guildLastNotifyMs.clear();
}

module.exports = {
    notifyCharLimitExceeded,
    COOLDOWN_MS,
    __resetLimitNotifyStateForTests,
};
