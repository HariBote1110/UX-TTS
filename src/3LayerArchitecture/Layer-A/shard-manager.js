require('dotenv').config();

const path = require('path');
const { ShardingManager } = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('[ShardManager] エラー: DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}

const parseBoolean = (value, defaultValue) => {
    if (value == null || value === '') return defaultValue;
    const normalised = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
    return defaultValue;
};

const parseInteger = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const parseShardList = (value) => {
    if (!value || value === 'auto') return 'auto';
    const list = String(value)
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((item) => Number.isInteger(item) && item >= 0);

    return list.length > 0 ? list : 'auto';
};

const totalShardsValue = process.env.SHARD_COUNT ?? 'auto';
const totalShards = totalShardsValue === 'auto' ? 'auto' : parseInteger(totalShardsValue, 'auto');
const shardList = parseShardList(process.env.SHARD_LIST);
const respawn = parseBoolean(process.env.SHARD_RESPAWN, true);
const spawnDelay = parseInteger(process.env.SHARD_SPAWN_DELAY, 5500);
const spawnTimeout = parseInteger(process.env.SHARD_READY_TIMEOUT, 30000);

const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
    token: BOT_TOKEN,
    totalShards,
    shardList,
    respawn,
    mode: 'process',
});

manager.on('shardCreate', (shard) => {
    console.log(`[ShardManager] Shard ${shard.id} を起動しました。`);

    shard.on('ready', () => {
        console.log(`[ShardManager] Shard ${shard.id} が Ready になりました。`);
    });

    shard.on('death', (processLike) => {
        const code = typeof processLike?.exitCode === 'number' ? processLike.exitCode : 'unknown';
        console.warn(`[ShardManager] Shard ${shard.id} が終了しました (code=${code})。`);
    });

    shard.on('disconnect', () => {
        console.warn(`[ShardManager] Shard ${shard.id} が Discord から切断されました。`);
    });

    shard.on('reconnecting', () => {
        console.warn(`[ShardManager] Shard ${shard.id} が再接続中です。`);
    });
});

(async () => {
    try {
        console.log(`[ShardManager] 起動設定: totalShards=${String(totalShards)}, shardList=${JSON.stringify(shardList)}, respawn=${respawn}, delay=${spawnDelay}ms, timeout=${spawnTimeout}ms`);

        await manager.spawn({
            amount: totalShards,
            delay: spawnDelay,
            timeout: spawnTimeout,
        });

        console.log('[ShardManager] 全シャードの起動処理を開始しました。');
    } catch (error) {
        console.error('[ShardManager] シャード起動に失敗しました:', error);
        process.exit(1);
    }
})();
