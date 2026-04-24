const { Events } = require('discord.js');
const {
    fetchSpeakerCache,
    updateActivity,
    resetMonthlyUsageCounts,
    sendPeriodicReport,
    createStatusEmbed
} = require('../../utils/helpers');
const { dispatchJoinRequest, requeueJoinRequest, completeJoinRequest, releaseVoiceChannelClaimsByOwner } = require('../../database');
const recoveryManager = require('../../utils/recoveryManager'); // ★追加
const { VoiceConnectionManager } = require('../../voiceManager'); // ★追加

// 定期タスクの間隔 (デフォルト24時間)
const TASK_INTERVAL_HOURS = parseInt(process.env.CACHE_SWEEP_INTERVAL_HOURS, 10) || 24;

const parseBoolean = (value, defaultValue) => {
    if (value == null || value === '') return defaultValue;
    const lowered = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    return defaultValue;
};

const JOIN_REQUEST_POLL_MS = Number.parseInt(process.env.JOIN_REQUEST_POLL_MS || '3000', 10);

function resolveBotInstanceId(client) {
    const explicit = String(process.env.BOT_INSTANCE_ID || '').trim();
    const shardId = Array.isArray(client?.shard?.ids) ? client.shard.ids[0] : 'single';
    const base = explicit || client?.user?.id || process.env.CLIENT_ID || 'unknown-bot';
    return `${base}:shard-${String(shardId)}`;
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        const currentShardId = Array.isArray(client.shard?.ids) ? client.shard.ids[0] : null;
        const isShardedProcess = Number.isInteger(currentShardId);
        const parsedMaintenanceShardId = Number.parseInt(process.env.MAINTENANCE_SHARD_ID ?? '0', 10);
        const maintenanceShardId = Number.isInteger(parsedMaintenanceShardId) ? parsedMaintenanceShardId : 0;
        const isMaintenanceShard = !isShardedProcess || currentShardId === maintenanceShardId;
        const shardPrefix = isShardedProcess ? `[Shard ${currentShardId}]` : '[Single]';

        console.log(`${shardPrefix} Ready! Logged in as ${client.user.tag}`);
        
        // --- 起動時タスク ---
        if (isMaintenanceShard) {
            console.log(`${shardPrefix} 起動時リクエストカウントリセットチェックを実行します...`);
            resetMonthlyUsageCounts(client);
        } else {
            console.log(`${shardPrefix} 非メンテナンスシャードのため、起動時リセットチェックをスキップします。`);
        }

        // --- ★ Stale クレーム解放 (Stale Claim Cleanup) ---
        // クラッシュや強制終了で残った前回インスタンスのクレームを起動時に一括解放する。
        // 解放後に復元処理を行うことで、自インスタンスが自分のクレームに弾かれるのを防ぐ。
        try {
            const ownerId = resolveBotInstanceId(client);
            const releaseResult = await releaseVoiceChannelClaimsByOwner(ownerId);
            const releasedCount = releaseResult?.released ?? 0;
            if (releasedCount > 0) {
                console.log(`${shardPrefix} [Startup] 前回インスタンスの stale クレームを ${releasedCount} 件解放しました。`);
            }
        } catch (e) {
            console.warn(`${shardPrefix} [Startup] Stale クレーム解放に失敗しました（Layer-D 未応答の可能性）: ${e.message}`);
        }

        // --- ★ 自動復元 (Connection Recovery) ---
        // 前回の接続情報を読み込んで、落ちる前のVCに自動接続する
        const savedConnections = recoveryManager.getAllConnections();
        const guildIds = Object.keys(savedConnections);
        
        if (guildIds.length > 0) {
            console.log(`${shardPrefix} [Recovery] ${guildIds.length} 件の接続情報を復元します...`);
            
            // サーバー負荷を考慮して少しずつ接続
            let restoredCount = 0;
            for (const guildId of guildIds) {
                const data = savedConnections[guildId];
                const guild = client.guilds.cache.get(guildId);

                if (!guild) {
                    // シャーディング時は他シャードが担当している可能性があるため削除しない
                    if (!isShardedProcess) {
                        recoveryManager.removeConnection(guildId);
                    }
                    continue;
                }

                const voiceChannel = guild.channels.cache.get(data.voiceChannelId);
                
                // チャンネルが存在し、かつボイスチャンネルである場合のみ復元
                if (voiceChannel && voiceChannel.isVoiceBased()) {
                    let manager = client.guildVoiceManagers.get(guildId);
                    if (!manager) {
                        manager = new VoiceConnectionManager(client, guildId);
                        client.guildVoiceManagers.set(guildId, manager);
                    }
                    
                    try {
                        const success = await manager.connect(voiceChannel, data.textChannelId);
                        if (!success) {
                            const failureCode = typeof manager.getLastConnectErrorCode === 'function'
                                ? manager.getLastConnectErrorCode()
                                : 'connect_failed';
                            // 他Bot担当中は再起動やTTL満了後に復旧できる可能性があるため保持する
                            if (failureCode !== 'claimed_by_other_bot') {
                                recoveryManager.removeConnection(guildId);
                            }
                        }
                    } catch (e) {
                        console.warn(`${shardPrefix} [Recovery] Failed to connect ${guildId}:`, e.message);
                        recoveryManager.removeConnection(guildId);
                    }
                    
                    restoredCount++;
                    // RateLimit回避のため少し待つ (500ms)
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    // チャンネルが消えている場合など
                    recoveryManager.removeConnection(guildId);
                }
            }
            console.log(`${shardPrefix} [Recovery] リカバリ処理を完了しました（対象: ${restoredCount}件）`);
        } else {
            console.log(`${shardPrefix} [Recovery] 復元する接続情報はありません。`);
        }


        // --- 定期実行タスク ---
        const intervalMs = TASK_INTERVAL_HOURS * 60 * 60 * 1000;
        if (isMaintenanceShard && intervalMs > 0) {
            console.log(`${shardPrefix} 定期タスクを ${TASK_INTERVAL_HOURS} 時間ごとに設定しました。`);
            setInterval(() => {
                console.log(`${shardPrefix} 定期タスク実行中...`);
                
                // 1. 月間リセットチェック
                resetMonthlyUsageCounts(client);
                
                // 2. システム統計レポート送信 (送信間隔を渡す)
                sendPeriodicReport(client, TASK_INTERVAL_HOURS);
                
            }, intervalMs);
        } else if (!isMaintenanceShard) {
            console.log(`${shardPrefix} 非メンテナンスシャードのため、定期タスクをスキップします。`);
        }

        // --- Join Request Worker (別bot割当て) ---
        const sharedModeEnabled = parseBoolean(process.env.BOT_SHARED_MODE, true);
        const joinRequestWorkerEnabled = parseBoolean(process.env.ENABLE_JOIN_REQUEST_WORKER, true);
        const pollMs = Number.isInteger(JOIN_REQUEST_POLL_MS) && JOIN_REQUEST_POLL_MS >= 1000 ? JOIN_REQUEST_POLL_MS : 3000;

        if (sharedModeEnabled && joinRequestWorkerEnabled) {
            const ownerId = resolveBotInstanceId(client);
            console.log(`${shardPrefix} JoinRequest Worker を起動します (owner=${ownerId}, interval=${pollMs}ms)`);

            const timer = setInterval(async () => {
                try {
                    const busyGuildIds = [];
                    const eligibleGuildIds = [];
                    for (const guildId of client.guilds.cache.keys()) {
                        eligibleGuildIds.push(guildId);
                    }
                    for (const [guildId, manager] of client.guildVoiceManagers.entries()) {
                        if (manager && typeof manager.isActive === 'function' && manager.isActive()) {
                            busyGuildIds.push(guildId);
                        }
                    }

                    const request = await dispatchJoinRequest(ownerId, busyGuildIds, eligibleGuildIds, 45);
                    if (!request || !request.id) return;

                    const targetGuild = client.guilds.cache.get(request.guild_id);
                    if (!targetGuild) {
                        await requeueJoinRequest(request.id, ownerId, 120);
                        return;
                    }

                    const voiceChannel = targetGuild.channels.cache.get(request.voice_channel_id);
                    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
                        await completeJoinRequest(request.id, ownerId, false, 'Voice channel not found');
                        return;
                    }

                    if (!voiceChannel.joinable || !voiceChannel.speakable) {
                        await completeJoinRequest(request.id, ownerId, false, 'Missing join/speak permission');
                        return;
                    }

                    let manager = client.guildVoiceManagers.get(targetGuild.id);
                    if (!manager) {
                        manager = new VoiceConnectionManager(client, targetGuild.id);
                        client.guildVoiceManagers.set(targetGuild.id, manager);
                    }

                    const success = await manager.connect(voiceChannel, request.text_channel_id || null);
                    if (!success) {
                        const failureCode = typeof manager.getLastConnectErrorCode === 'function' ? manager.getLastConnectErrorCode() : 'connect_failed';
                        await completeJoinRequest(request.id, ownerId, false, String(failureCode));
                        return;
                    }

                    await completeJoinRequest(request.id, ownerId, true, 'assigned');
                    await updateActivity(client);

                    if (request.text_channel_id) {
                        const textChannel = targetGuild.channels.cache.get(request.text_channel_id);
                        if (textChannel && textChannel.isTextBased()) {
                            const embed = createStatusEmbed('success', `別botインスタンスが **${voiceChannel.name}** への接続を担当しました。`);
                            textChannel.send({ embeds: [embed] }).catch(() => {});
                        }
                    }
                } catch (error) {
                    console.warn(`${shardPrefix} JoinRequest Worker error: ${error.message}`);
                }
            }, pollMs);

            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        }

        // キャッシュ・アクティビティ更新
        await fetchSpeakerCache(client); 
        await updateActivity(client); 
    },
};
