const {
    Events,
    ChannelType,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const { VoiceConnectionManager } = require('../../voiceManager');
const {
    getUserSettings,
    getGuildSettings,
    getIgnoreChannels,
    getAllowChannels,
    getChannelPair,
    getAutoVCGenerator,
    addActiveChannel,
    getActiveChannel,
    removeActiveChannel,
    claimVoiceChannel
} = require('../../database');
const { updateActivity, createStatusEmbed } = require('../../utils/helpers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 入退室読み上げレートリミット ---
// 同一ユーザーが短時間に入退室を繰り返してもキューを荒らせないよう、
// ユーザー×ギルド単位でクールダウンを設ける。
const JOIN_LEAVE_COOLDOWN_MS = Number.parseInt(process.env.JOIN_LEAVE_COOLDOWN_MS || '10000', 10);
const joinLeaveCooldowns = new Map(); // key: `${guildId}:${userId}` → lastTimestamp

function isJoinLeaveRateLimited(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const last = joinLeaveCooldowns.get(key);
    if (last && now - last < JOIN_LEAVE_COOLDOWN_MS) {
        return true;
    }
    joinLeaveCooldowns.set(key, now);
    return false;
}

// クールダウン Map の肥大化を防ぐ定期クリーンアップ（5分ごと）
// /reload で再 require されても重複しないようプロセス全体でガード
if (!global.__joinLeaveCooldownCleanupStarted) {
    global.__joinLeaveCooldownCleanupStarted = true;
    setInterval(() => {
        const threshold = Date.now() - JOIN_LEAVE_COOLDOWN_MS;
        for (const [key, ts] of joinLeaveCooldowns) {
            if (ts < threshold) joinLeaveCooldowns.delete(key);
        }
    }, 5 * 60 * 1000).unref();
}
const parseBoolean = (value, defaultValue) => {
    if (value == null || value === '') return defaultValue;
    const lowered = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    return defaultValue;
};
const ENABLE_AUTOVC_CLAIM = parseBoolean(process.env.ENABLE_VC_CLAIM, true);
const AUTO_VC_LOCK_TTL_RAW = Number.parseInt(process.env.AUTOVC_LOCK_TTL_SECONDS || process.env.VC_CLAIM_TTL_SECONDS || '20', 10);
const AUTO_VC_LOCK_TTL_SECONDS = Number.isInteger(AUTO_VC_LOCK_TTL_RAW) && AUTO_VC_LOCK_TTL_RAW > 0 ? AUTO_VC_LOCK_TTL_RAW : 20;

function resolveBotInstanceId(client) {
    const explicit = String(process.env.BOT_INSTANCE_ID || '').trim();
    const shardId = Array.isArray(client?.shard?.ids) && Number.isInteger(client.shard.ids[0]) ? client.shard.ids[0] : 'single';
    const base = explicit || client?.user?.id || process.env.CLIENT_ID || 'unknown-bot';
    return `${base}:shard-${String(shardId)}`;
}

function getBotInstanceId(client) {
    if (!client.__botInstanceId) {
        client.__botInstanceId = resolveBotInstanceId(client);
    }
    return client.__botInstanceId;
}

async function claimAutoVCLock(guildId, lockId, ownerId) {
    if (!ENABLE_AUTOVC_CLAIM) {
        return { success: true, claimed: true };
    }

    const result = await claimVoiceChannel(guildId, lockId, ownerId, AUTO_VC_LOCK_TTL_SECONDS);
    if (!result.success) {
        console.warn(`[${guildId}] AutoVC lock API未応答のためロックなしで継続します: ${lockId}`);
        return { success: false, claimed: true };
    }
    return result;
}

async function handleAutoJoin(oldState, newState, client, guildId, userId, isMemberBot, manager, isBotConnected) {
    if (!newState.channelId || newState.channelId === oldState.channelId || isMemberBot) return;

    const targetChannel = newState.channel;
    let shouldJoin = false;
    let joinReason = '';

    const userSettings = await getUserSettings(guildId, userId);
    const guildSettings = await getGuildSettings(guildId);

    if (userSettings.auto_join === 1) {
        shouldJoin = true;
        joinReason = 'user_follow';
    } else if (guildSettings.auto_join_enabled === 1) {
        if (!isBotConnected) {
            shouldJoin = true;
            joinReason = 'server_auto';
        } else {
            // すでに接続済みの場合、現在一人きりなら移動を検討
            const currentBotChannel = manager.getVoiceChannel();
            if (currentBotChannel && currentBotChannel.id !== newState.channelId) {
                const channel = client.channels.cache.get(currentBotChannel.id);
                if (channel && channel.isVoiceBased()) {
                    const humanCount = channel.members.filter(m => !m.user.bot).size;
                    if (humanCount === 0) {
                        shouldJoin = true;
                        joinReason = 'server_auto';
                    }
                }
            }
        }
    }

    if (!shouldJoin || !targetChannel.joinable || !targetChannel.speakable) return;

    const allowList = await getAllowChannels(guildId);
    const ignoreList = await getIgnoreChannels(guildId);
    let isTarget = false;

    if (allowList.length > 0) {
        if (allowList.includes(targetChannel.id)) isTarget = true;
    } else {
        if (!ignoreList.includes(targetChannel.id)) isTarget = true;
    }

    if (!isTarget) return;

    // AutoVCトリガーVCは自動接続の対象外（複数Bot時の干渉を防ぐ）
    const autoVCGenerator = await getAutoVCGenerator(guildId, targetChannel.id);
    if (autoVCGenerator) return;

    let targetManager = manager;
    if (!targetManager) {
        targetManager = new VoiceConnectionManager(client, guildId);
        client.guildVoiceManagers.set(guildId, targetManager);
    }

    // ★修正: デフォルトは null (未定) とする
    // これにより、接続直後はどのチャンネルも読み上げない状態にする
    let bindTextChannelId = null;

    // ペアリング設定がある場合のみ、最初から指定
    const pair = await getChannelPair(guildId, targetChannel.id);
    if (pair) {
        bindTextChannelId = pair.text_channel_id;
    }

    // 接続実行 (bindTextChannelId が null なら未定状態で接続)
    const success = await targetManager.connect(targetChannel, bindTextChannelId);

    if (!success) return;

    await updateActivity(client);

    // ペアリング設定で最初からバインドされた場合のみログを出す
    // (未定の場合は、ユーザーがチャットを打ったタイミングで通知する)
    if (!bindTextChannelId) return;

    const tc = client.channels.cache.get(bindTextChannelId);
    // VC内チャットも考慮して isTextBased() で判定
    if (tc && tc.isTextBased()) {
        const embed = createStatusEmbed('success', `**自動接続しました**\n🔊 ${targetChannel.name} に参加し、このチャンネルを読み上げ対象に設定しました。`);
        tc.send({ embeds: [embed] }).catch(e => console.error('Error sending auto-join success embed:', e));
    }
}

module.exports = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState, client) {
        const guildId = newState.guild.id;
        if (!newState.member) return;
        const userId = newState.member.id;
        const isMemberBot = newState.member.user?.bot === true;

        // Bot自身のイベントは無視
        if (userId === client.user.id) return;

        const manager = client.guildVoiceManagers.get(guildId);
        const isBotConnected = manager && manager.isActive();

        // ==========================================
        // 1. 自動接続 (Auto Join)
        // ==========================================
        await handleAutoJoin(oldState, newState, client, guildId, userId, isMemberBot, manager, isBotConnected);

        // ==========================================
        // 2. AutoVC (自動チャンネル作成機能)
        // ==========================================

        // A. チャンネル作成 (入室検知)
        if (newState.channelId && newState.channelId !== oldState.channelId && !isMemberBot) {
            const generator = await getAutoVCGenerator(newState.guild.id, newState.channelId);

            if (generator) {
                const member = newState.member;
                const guild = newState.guild;
                const ownerId = getBotInstanceId(client);
                const createLockId = `autovc:create:${newState.channelId}:${member.id}`;
                const createLock = await claimAutoVCLock(guild.id, createLockId, ownerId);
                if (!createLock.claimed) {
                    const claimedBy = createLock.owner_id || 'unknown';
                    console.log(`[${guild.id}] AutoVC作成をスキップ: lock=${createLockId} owner=${claimedBy}`);
                } else {
                    try {
                        const channelName = generator.naming_pattern.replace('{user}', member.displayName);
                        const createdVoice = await guild.channels.create({
                            name: channelName,
                            type: ChannelType.GuildVoice,
                            parent: generator.category_id,
                            permissionOverwrites: [
                                { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect] },
                                { id: guild.roles.everyone, allow: [PermissionFlagsBits.Connect] }
                            ]
                        });

                        await member.voice.setChannel(createdVoice);

                        const embed = new EmbedBuilder()
                            .setTitle(`🎛️ ${channelName} コントロールパネル`)
                            .setDescription(`このチャンネルのオーナー: ${member}\nここ(VC内チャット)で会話や設定変更ができます。`)
                            .setColor(0x00AAFF);

                        const row1 = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('autovc_join_bot').setLabel('読み上げ参加').setStyle(ButtonStyle.Success).setEmoji('🤖'),
                            new ButtonBuilder().setCustomId('autovc_rename').setLabel('名前変更').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
                            new ButtonBuilder().setCustomId('autovc_limit').setLabel('人数制限').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
                            new ButtonBuilder().setCustomId('autovc_lock').setLabel('ロック/解除').setStyle(ButtonStyle.Danger).setEmoji('🔒')
                        );

                        await createdVoice.send({ embeds: [embed], components: [row1] });

                        await addActiveChannel(createdVoice.id, generator.text_channel_id, guild.id, member.id);

                    } catch (e) {
                        console.error('AutoVC Create Error:', e);
                    }
                }
            }
        }

        // B. チャンネル削除 & アーカイブ処理 (退出検知)
        if (oldState.channelId) {
            const activeInfo = await getActiveChannel(oldState.channelId);
            if (activeInfo) {
                const channel = oldState.channel;
                if (channel && channel.members.size === 0) {
                    const ownerId = getBotInstanceId(client);
                    const cleanupLockId = `autovc:cleanup:${oldState.channelId}`;
                    const cleanupLock = await claimAutoVCLock(guildId, cleanupLockId, ownerId);
                    if (!cleanupLock.claimed) {
                        const claimedBy = cleanupLock.owner_id || 'unknown';
                        console.log(`[${guildId}] AutoVCクリーンアップをスキップ: lock=${cleanupLockId} owner=${claimedBy}`);
                    } else {
                        try {
                            let messages = [];
                            try {
                                const fetched = await channel.messages.fetch({ limit: 100 });
                                messages = Array.from(fetched.values()).reverse();
                            } catch (e) { console.log('VC Message Fetch Error:', e.message); }

                            if (activeInfo.archive_channel_id && messages.length > 0) {
                                const archiveParent = oldState.guild.channels.cache.get(activeInfo.archive_channel_id);

                                if (archiveParent && archiveParent.isTextBased()) {
                                    const dateStr = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                                    const threadName = `📦 Log: ${channel.name} (${dateStr})`;

                                    const thread = await archiveParent.threads.create({
                                        name: threadName,
                                        autoArchiveDuration: 60,
                                        reason: 'AutoVC Session Archive'
                                    });

                                    let webhook;
                                    try {
                                        const hooks = await archiveParent.fetchWebhooks();
                                        webhook = hooks.find(h => h.owner.id === client.user.id);
                                        if (!webhook) {
                                            webhook = await archiveParent.createWebhook({
                                                name: 'AutoVC Archiver',
                                                avatar: client.user.displayAvatarURL(),
                                            });
                                        }
                                    } catch (whErr) {
                                        const warnEmbed = createStatusEmbed('warning', 'Botに「ウェブフックの管理」権限がないため、チャットログを完全な形式で保存できませんでした。');
                                        await thread.send({ embeds: [warnEmbed] });
                                    }

                                    if (webhook) {
                                        const infoEmbed = createStatusEmbed('info', `**${channel.name}** のチャットアーカイブを作成します...`);
                                        await thread.send({ embeds: [infoEmbed] });
                                        for (const m of messages) {
                                            if (m.author.bot) continue;
                                            let content = m.content || '';
                                            if (m.attachments.size > 0) {
                                                const urls = m.attachments.map(a => a.url).join('\n');
                                                content += `\n${urls}`;
                                            }
                                            if (content.trim().length > 0) {
                                                await webhook.send({
                                                    content: content,
                                                    username: m.author.displayName || m.author.username,
                                                    avatarURL: m.author.displayAvatarURL(),
                                                    threadId: thread.id,
                                                });
                                                await sleep(800);
                                            }
                                        }
                                        await thread.setLocked(true);
                                        await thread.setArchived(true);
                                    }
                                }
                            }

                            await channel.delete().catch(e => console.error('Error deleting AutoVC channel:', e));
                            await removeActiveChannel(oldState.channelId);

                        } catch (e) {
                            console.error('AutoVC Delete/Archive Error:', e);
                        }
                    }
                }
            }
        }

        // ==========================================
        // 3. 自動切断 & 入退室読み上げ
        // ==========================================
        if (isBotConnected) {
            const currentBotChannel = manager.getVoiceChannel();
            if (currentBotChannel) {
                const channel = client.channels.cache.get(currentBotChannel.id);

                if (channel && channel.isVoiceBased()) {
                    const isEventInBotChannel = (oldState.channelId === currentBotChannel.id || newState.channelId === currentBotChannel.id);
                    if (isEventInBotChannel) {
                        const humanCount = channel.members.filter(member => !member.user.bot).size;
                        if (humanCount === 0) {
                            console.log(`[${guildId}] VC自動切断: ${channel.name}`);
                            manager.disconnect(true);
                            return;
                        }

                        const guildSettings = await getGuildSettings(guildId);
                        const memberName = newState.member.displayName;
                        if (newState.channelId === currentBotChannel.id && oldState.channelId !== currentBotChannel.id) {
                            if (guildSettings.read_join === 1 && !isJoinLeaveRateLimited(guildId, userId)) {
                                await manager.addQueue(`${memberName}さんが入室しました`, userId);
                            }
                        }
                        else if (oldState.channelId === currentBotChannel.id && newState.channelId !== currentBotChannel.id) {
                            if (guildSettings.read_leave === 1 && !isJoinLeaveRateLimited(guildId, userId)) {
                                await manager.addQueue(`${memberName}さんが退出しました`, userId);
                            }
                        }
                    }
                    manager.updateSelfDeaf();
                }
            }
        }
    },
};
