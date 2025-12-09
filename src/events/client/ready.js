const { Events } = require('discord.js');
const { sweepCache } = require('../../audioCache');
const { fetchSpeakerCache, updateActivity, resetMonthlyUsageCounts } = require('../../utils/helpers');

const CACHE_SWEEP_INTERVAL_HOURS = parseInt(process.env.CACHE_SWEEP_INTERVAL_HOURS, 10) || 24;

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        
        // 起動時タスク
        console.log('起動時キャッシュクリーニングを実行します...');
        sweepCache(); 
        console.log('起動時リクエストカウントリセットチェックを実行します...');
        resetMonthlyUsageCounts(client); 

        // 定期実行タスク
        const intervalMs = CACHE_SWEEP_INTERVAL_HOURS * 60 * 60 * 1000;
        if (intervalMs > 0) {
            console.log(`定期タスクを ${CACHE_SWEEP_INTERVAL_HOURS} 時間ごとに設定しました。`);
            setInterval(() => {
                console.log('定期キャッシュクリーニングを実行します...');
                sweepCache();
                console.log('定期リクエストカウントリセットチェックを実行します...');
                resetMonthlyUsageCounts(client); 
            }, intervalMs);
        }

        await fetchSpeakerCache(client); 
        await updateActivity(client); 
    },
};