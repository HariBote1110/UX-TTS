const { ActivityType, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const {
    getAllGuildUsage, resetGuildUsage, getCurrentMonth,
    getUserSettings, getGuildSettings, getIgnoreChannels, getAllowChannels, getAllChannelPairs, getAutoVCGenerators
} = require('../database');
const { sweepCache } = require('../audioCache');
const { sendErrorLog } = require('../errorLogger');
const { getAverageLatencyStats } = require('./statsManager');

const { VOICEVOX_API_URL, CACHE_SWEEP_INTERVAL_HOURS, ITEMS_PER_PAGE, BOT_OWNER_ID, MONITOR_CHANNEL_ID } = process.env;
const itemsPerPage = parseInt(ITEMS_PER_PAGE, 10) || 25;

const OJT_SPEAKERS = [
    { name: 'メイ (標準)', speaker_uuid: 'ojt_mei_normal', styles: [{ id: 0, name: 'ノーマル' }] },
];

const SYSTEM_ANNOUNCEMENT = {
    enabled: true,
    vc_suffix: '\n\n💡 **重要:** 利用規約ならびにプライバシーポリシーが2025年12月9日に更新されました。Botのプロフィールからご確認お願いいたします。\n\nアンケートの回答をお願いします！\n[アンケートはこちらから](<https://forms.gle/icqsh5gP8VWN1XhY8>)',
    dashboard: {
        title: '辞書のエクスポート/インポートに対応しました。',
        message: '他のbotからのインポート、UX TTSから他のbotへのエクスポートができます。',
        type: 'info'
    }
};

function getAnnouncement() {
    return SYSTEM_ANNOUNCEMENT;
}

const EMBED_COLOR_MAP = {
    success: 0x57F287,
    info: 0x00AAFF,
    warning: 0xFEE75C,
    error: 0xED4245
};

const EMBED_TITLE_MAP = {
    success: '✅ 成功',
    info: 'ℹ️ お知らせ',
    warning: '⚠️ 注意',
    error: '❌ エラー'
};

function createStatusEmbed(type = 'info', description = '', title = null) {
    const normalized = EMBED_COLOR_MAP[type] ? type : 'info';
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR_MAP[normalized])
        .setDescription(description || '');

    const resolvedTitle = title || EMBED_TITLE_MAP[normalized] || null;
    if (resolvedTitle) {
        embed.setTitle(resolvedTitle);
    }

    return embed;
}

function createStatusMessage(type, description, options = {}) {
    const {
        title = null,
        flags = null,
        components = null,
        files = null,
        content = undefined,
        extraEmbeds = []
    } = options;

    const payload = {
        embeds: [createStatusEmbed(type, description, title), ...extraEmbeds]
    };

    if (flags) payload.flags = flags;
    if (components) payload.components = components;
    if (files) payload.files = files;
    if (content !== undefined) payload.content = content;

    return payload;
}

// 定期レポート送信関数
async function sendPeriodicReport(client, intervalHours) {
    if (!MONITOR_CHANNEL_ID) return;

    try {
        const channel = client.channels.cache.get(MONITOR_CHANNEL_ID);
        if (channel && channel.isTextBased()) {
            const stats = getAverageLatencyStats(intervalHours);

            const embed = new EmbedBuilder()
                .setTitle('📊 定期システムパフォーマンスレポート')
                .setColor(0x00AAFF)
                .addFields(
                    { name: `⚡ 平均再生遅延 (直近${intervalHours}h)`, value: `**${stats.avg} ms**`, inline: true },
                    { name: '📉 最小 / 最大', value: `${stats.min} ms / ${stats.max} ms`, inline: true },
                    { name: '🔢 計測サンプル数', value: `${stats.count} 件`, inline: true }
                )
                .setFooter({ text: 'UX TTS System Monitor' })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('定期レポート送信エラー:', e);
    }
}

async function resetMonthlyUsageCounts(client) {
    const currentMonth = getCurrentMonth();
    try {
        const allUsage = await getAllGuildUsage();
        let resetCount = 0;
        for (const usage of allUsage) {
            if (usage.last_reset_month !== currentMonth) {
                await resetGuildUsage(usage.guild_id, currentMonth);
                resetCount++;
            }
        }
        if (resetCount > 0) console.log(`${resetCount} サーバーの月間リクエスト数をリセットしました。`);
    } catch (e) {
        console.error('月間リクエスト数のリセット処理中にエラー:', e.message);
        sendErrorLog(client, e, { place: 'resetMonthlyUsageCounts' });
    }
}

async function fetchSpeakerCache(client) {
    try {
        const response = await fetch(`${VOICEVOX_API_URL}/speakers`);
        if (response.ok) {
            client.speakerCache = await response.json();
            console.log(`VOICEVOXから ${client.speakerCache.length} 名の話者情報をキャッシュしました。`);
        } else {
            console.error('VOICEVOX話者リストの取得に失敗しました。');
            sendErrorLog(client, new Error('VOICEVOX API returned non-ok status'), { place: 'fetchSpeakerCache' });
        }
    } catch (e) {
        console.error('VOICEVOXエンジンへの初回接続に失敗:', e.message);
        sendErrorLog(client, e, { place: 'fetchSpeakerCache' });
    }
}

async function updateActivity(client) {
    try {
        const totalGuilds = client.guilds.cache.size;
        const activeConnections = client.guildVoiceManagers.size;
        client.user.setActivity(
            `${activeConnections}VCで読み上げ中 / ${totalGuilds}サーバーに導入`,
            { type: ActivityType.Playing }
        );
    } catch (e) {
        console.error('アクティビティの更新に失敗:', e.message);
    }
}

function buildSpeakerTargetToken(targetScope, targetId) {
    const scope = targetScope === 'guild' ? 'guild' : 'user';
    return `${scope}:${targetId}`;
}

// 話者設定UIを生成（個人設定 / サーバーデフォルト設定）
async function createSpeakerUIPayload(client, page, targetId, type = 'voicevox', executorMember = null, targetScope = 'user', showBack = false) {
    const speakerList = (type === 'ojt') ? OJT_SPEAKERS : (client.speakerCache || []);
    const typeName = (type === 'ojt') ? 'Open JTalk' : 'VOICEVOX';
    const otherType = (type === 'ojt') ? 'voicevox' : 'ojt';
    const otherTypeName = (type === 'ojt') ? 'VOICEVOX' : 'Open JTalk';
    const resolvedScope = targetScope === 'guild' ? 'guild' : 'user';
    const targetToken = buildSpeakerTargetToken(resolvedScope, targetId);
    const isAdmin = executorMember
        ? (executorMember.permissions.has(PermissionsBitField.Flags.Administrator) || executorMember.id === BOT_OWNER_ID)
        : false;
    const targetLabel = resolvedScope === 'guild' ? '🌐 サーバー全体のデフォルト話者' : `👤 <@${targetId}>`;
    const scopeDescription = resolvedScope === 'guild'
        ? '\n※ 個人の話者設定が未設定のメンバーに適用されます。'
        : '';

    if (speakerList.length === 0) {
        return {
            content: `${typeName}の話者リストを取得できませんでした。`,
            embeds: [], components: [], flags: [MessageFlags.Ephemeral]
        };
    }

    const totalPages = Math.ceil(speakerList.length / itemsPerPage);
    page = Math.max(1, Math.min(page, totalPages));

    const startIndex = (page - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const speakersOnPage = speakerList.slice(startIndex, endIndex);

    const embed = new EmbedBuilder()
        .setTitle(`話者設定 (${typeName})`)
        .setDescription(`下のメニューからキャラクターを選択してください。\n設定対象: ${targetLabel}\n現在のモード: **${typeName}**${scopeDescription}`)
        .setColor(type === 'ojt' ? 0xFF9900 : 0x00FF00)
        .setFooter({ text: `ページ ${page} / ${totalPages}` });

    const characterOptions = speakersOnPage.map(speaker => ({
        label: speaker.name,
        description: `スタイル数: ${speaker.styles.length}`,
        value: speaker.speaker_uuid,
    }));

    // コンポーネント配列
    const components = [];

    if (characterOptions.length === 0) {
        embed.setDescription('表示できる話者がありません。');
    } else {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select_character_page_${page}_${targetToken}_${type}`)
            .setPlaceholder(`${typeName} キャラクターを選択...`).addOptions(characterOptions);
        const menuRow = new ActionRowBuilder().addComponents(selectMenu);
        components.push(menuRow);

        const buttonRow = new ActionRowBuilder();
        const prevButton = new ButtonBuilder()
            .setCustomId(`speaker_page_${page - 1}_${targetToken}_${type}`)
            .setLabel('◀ 前へ').setStyle(ButtonStyle.Primary).setDisabled(page === 1);

        const switchButton = new ButtonBuilder()
            .setCustomId(`speaker_type_switch_${otherType}_${targetToken}`)
            .setLabel(`${otherTypeName} に切り替え`)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄');

        const randomButton = new ButtonBuilder()
            .setCustomId(`speaker_random_${targetToken}_${type}`)
            .setLabel('ランダム')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎲');

        const nextButton = new ButtonBuilder()
            .setCustomId(`speaker_page_${page + 1}_${targetToken}_${type}`)
            .setLabel('次へ ▶').setStyle(ButtonStyle.Primary).setDisabled(page === totalPages);

        buttonRow.addComponents(prevButton, switchButton, randomButton, nextButton);
        components.push(buttonRow);
    }

    if (isAdmin) {
        const scopeButtons = new ActionRowBuilder();
        const guildId = executorMember?.guild?.id;

        if (resolvedScope === 'user' && guildId) {
            scopeButtons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`speaker_scope_switch_guild_${type}_${guildId}`)
                    .setLabel('🌐 サーバー既定を編集')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (resolvedScope === 'guild') {
            scopeButtons.addComponents(
                new ButtonBuilder()
                    .setCustomId(`speaker_scope_switch_user_${type}_${executorMember.id}`)
                    .setLabel('👤 個人設定へ戻る')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`speaker_guild_default_reset_${targetToken}_${type}`)
                    .setLabel('既定話者をリセット')
                    .setStyle(ButtonStyle.Danger)
            );
        }

        if (scopeButtons.components.length > 0) {
            components.push(scopeButtons);
        }

        const userSelect = new UserSelectMenuBuilder()
            .setCustomId(`speaker_user_select_${type}`)
            .setPlaceholder('（管理者用）個人設定対象のユーザーを選択')
            .setMinValues(1)
            .setMaxValues(1);

        const userRow = new ActionRowBuilder().addComponents(userSelect);
        components.push(userRow);
    }

    if (showBack) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)
        ));
    }

    return { content: '', embeds: [embed], components: components, flags: [MessageFlags.Ephemeral] };
}

async function createAutojoinMenuPayload(guildId, userId, memberPermissions, { showBack = false } = {}) {
    const userSettings = await getUserSettings(guildId, userId);
    const guildSettings = await getGuildSettings(guildId);
    const ignoreChannels = await getIgnoreChannels(guildId);
    const allowChannels = await getAllowChannels(guildId);
    const pairs = await getAllChannelPairs(guildId);

    const isAdmin = memberPermissions.has(PermissionsBitField.Flags.Administrator) || userId === BOT_OWNER_ID;

    const isUserAuto = userSettings.auto_join === 1;
    const isServerAuto = guildSettings.auto_join_enabled === 1;
    const modeText = allowChannels.length > 0 ? '⭕ **許可リストモード** (リスト外は無視)' : '🚫 **除外リストモード** (リスト外は接続)';

    const embed = new EmbedBuilder()
        .setTitle('🤖 自動接続設定メニュー')
        .setDescription('Botがボイスチャンネルへ自動的に接続する機能の設定です。')
        .setColor(0x00AAFF)
        .addFields(
            {
                name: '💡 動作の仕組み',
                value: '1. **許可リスト**に登録がある場合、そのチャンネル**のみ**自動接続します。\n2. 許可リストが空の場合、**除外リスト**に含まれていないチャンネルに自動接続します。\n3. **ペアリング**設定があるVCでは、指定されたテキストチャンネルを読み上げ対象にします。',
                inline: false
            },
            {
                name: '👤 個人設定 (あなた)',
                value: `状態: **${isUserAuto ? 'ON' : 'OFF'}**\nあなたがVCに入るとBotが追従します。`,
                inline: true
            },
            {
                name: '🌐 サーバー設定 (全体)',
                value: `状態: **${isServerAuto ? 'ON' : 'OFF'}**\n誰かがVCに入るとBotが接続します。`,
                inline: true
            },
            {
                name: '⚙️ 詳細設定状況 (サーバー)',
                value: `現在の動作モード: ${modeText}\n・許可リスト: **${allowChannels.length}** 件\n・除外リスト: **${ignoreChannels.length}** 件\n・ペアリング: **${pairs.length}** 件`,
                inline: false
            }
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('autojoin_menu_user_toggle')
            .setLabel(`個人設定: ${isUserAuto ? 'ON' : 'OFF'}`)
            .setStyle(isUserAuto ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('👤')
    );

    if (isAdmin) {
        row1.addComponents(
            new ButtonBuilder()
                .setCustomId('autojoin_menu_server_toggle')
                .setLabel(`サーバー設定: ${isServerAuto ? 'ON' : 'OFF'}`)
                .setStyle(isServerAuto ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('🌐')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_menu_allow').setLabel('許可リスト設定').setStyle(ButtonStyle.Primary).setEmoji('⭕'),
            new ButtonBuilder().setCustomId('autojoin_menu_ignore').setLabel('除外リスト設定').setStyle(ButtonStyle.Primary).setEmoji('🚫'),
            new ButtonBuilder().setCustomId('autojoin_menu_pair').setLabel('ペアリング設定').setStyle(ButtonStyle.Primary).setEmoji('🔗')
        );
        const rows = [row1, row2];
        if (showBack) rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)
        ));
        return { embeds: [embed], components: rows, flags: [MessageFlags.Ephemeral] };
    }

    const rows = [row1];
    if (showBack) rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)
    ));
    return { embeds: [embed], components: rows, flags: [MessageFlags.Ephemeral] };
}

async function createAutoVCMenuPayload(guild, userId, memberPermissions, { showBack = false } = {}) {
    const generators = await getAutoVCGenerators(guild.id);
    const isAdmin = memberPermissions.has(PermissionsBitField.Flags.Administrator)
        || memberPermissions.has(PermissionsBitField.Flags.ManageChannels)
        || userId === BOT_OWNER_ID;

    const lines = [];
    for (const generator of generators) {
        const trigger = generator.channel_id ? `<#${generator.channel_id}>` : '未設定';
        const category = generator.category_id ? `<#${generator.category_id}>` : '未設定';
        const logChannel = generator.text_channel_id ? `<#${generator.text_channel_id}>` : '未設定';
        const pattern = generator.naming_pattern || '{user}の部屋';
        const line = `${lines.length + 1}. ${trigger} → ${category}\nログ: ${logChannel} / 命名: \`${pattern}\``;

        const joined = lines.length > 0 ? `${lines.join('\n')}\n${line}` : line;
        if (joined.length > 900) break;
        lines.push(line);
    }

    let listText = lines.length > 0 ? lines.join('\n') : 'まだAutoVC設定はありません。';
    if (generators.length > lines.length) {
        listText += `\n...ほか ${generators.length - lines.length} 件`;
    }

    const embed = new EmbedBuilder()
        .setTitle('🎛️ AutoVC 設定メニュー')
        .setDescription('入室をトリガーに、ユーザー専用VCを自動作成する機能の設定です。')
        .setColor(0x00AAFF)
        .addFields(
            { name: '📊 設定数', value: `**${generators.length} 件**`, inline: true },
            { name: '🔐 編集権限', value: isAdmin ? '管理者: 変更可能' : '閲覧のみ', inline: true },
            { name: '📋 登録一覧', value: listText, inline: false }
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('autovc_config_refresh')
            .setLabel('再読み込み')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄'),
        new ButtonBuilder()
            .setCustomId('autovc_config_add')
            .setLabel('設定を追加')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕')
            .setDisabled(!isAdmin),
        new ButtonBuilder()
            .setCustomId('autovc_config_delete')
            .setLabel('設定を削除')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
            .setDisabled(!isAdmin || generators.length === 0)
    );

    if (showBack) {
        row.addComponents(
            new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)
        );
    }

    return { embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] };
}

function createActiveSpeechPanelPayload(isEnabled, { showBack = false } = {}) {
    const buttons = [
        new ButtonBuilder()
            .setCustomId('activespeech_enable')
            .setLabel('有効にする')
            .setStyle(ButtonStyle.Success)
            .setDisabled(isEnabled),
        new ButtonBuilder()
            .setCustomId('activespeech_disable')
            .setLabel('無効にする')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!isEnabled),
    ];
    if (showBack) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('config_back_main')
                .setLabel('◀ 戻る')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    const row = new ActionRowBuilder().addComponents(...buttons);
    return createStatusMessage(
        'info',
        `ActiveSpeech機能の設定:\n現在: **${isEnabled ? 'ON ✅' : 'OFF ❌'}**\nボタンで切り替えられます。`,
        { components: [row] }
    );
}

async function createConfigMenuPayload(guildId, member) {
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator) || member.user.id === BOT_OWNER_ID;
    const guildSettings = await getGuildSettings(guildId);
    const userSettings = await getUserSettings(guildId, member.user.id);

    const embed = new EmbedBuilder()
        .setTitle('⚙️ 設定メニュー (Config)')
        .setDescription('以下のボタンから各設定を行えます。')
        .setColor(0x5865F2);

    embed.addFields(
        { name: '📢 入退室読み上げ (サーバー全体)', value: `入室: **${guildSettings.read_join ? 'ON' : 'OFF'}** / 退出: **${guildSettings.read_leave ? 'ON' : 'OFF'}**`, inline: false },
        { name: '🤖 自動接続', value: '詳細設定は下のボタンからメニューを開いてください。AutoVC設定もここから開けます。', inline: false },
        { name: '🗣️ 音声設定 (個人)', value: `話速: **${(userSettings.speed || 1.0).toFixed(1)}** / ピッチ: **${(userSettings.pitch || 0.0).toFixed(2)}**`, inline: false }
    );

    const rowVoice = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config_open_speaker').setLabel('話者を変更').setStyle(ButtonStyle.Success).setEmoji('🗣️'),
        new ButtonBuilder().setCustomId('config_open_speed').setLabel('話速設定').setStyle(ButtonStyle.Secondary).setEmoji('⏩'),
        new ButtonBuilder().setCustomId('config_open_pitch').setLabel('ピッチ設定').setStyle(ButtonStyle.Secondary).setEmoji('🎚️')
    );
    const rowJoinLeave = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config_toggle_join').setLabel(`入室読み上げ: ${guildSettings.read_join ? 'ON' : 'OFF'}`).setStyle(guildSettings.read_join ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('👋').setDisabled(!isAdmin),
        new ButtonBuilder().setCustomId('config_toggle_leave').setLabel(`退出読み上げ: ${guildSettings.read_leave ? 'ON' : 'OFF'}`).setStyle(guildSettings.read_leave ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🚪').setDisabled(!isAdmin)
    );
    const rowAutoJoin = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config_open_autojoin').setLabel('自動接続・追従設定を開く').setStyle(ButtonStyle.Primary).setEmoji('🤖'),
        new ButtonBuilder().setCustomId('config_open_autovc').setLabel('AutoVC設定を開く').setStyle(ButtonStyle.Primary).setEmoji('🎛️')
    );
    const rowOther = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('config_open_dict').setLabel('辞書設定').setStyle(ButtonStyle.Primary).setEmoji('📖'),
        new ButtonBuilder().setCustomId('config_open_activespeech').setLabel('ActiveSpeech').setStyle(ButtonStyle.Primary).setEmoji('🎙️')
    );

    return { embeds: [embed], components: [rowVoice, rowJoinLeave, rowAutoJoin, rowOther] };
}

module.exports = {
    resetMonthlyUsageCounts,
    fetchSpeakerCache,
    updateActivity,
    createStatusEmbed,
    createStatusMessage,
    createSpeakerUIPayload,
    createAutojoinMenuPayload,
    createAutoVCMenuPayload,
    createActiveSpeechPanelPayload,
    createConfigMenuPayload,
    getAnnouncement,
    sendPeriodicReport,
    OJT_SPEAKERS
};
