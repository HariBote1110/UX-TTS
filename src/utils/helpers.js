const { ActivityType, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const { 
    getAllGuildUsage, resetGuildUsage, getCurrentMonth,
    getUserSettings, getGuildSettings, getIgnoreChannels, getAllowChannels, getAllChannelPairs
} = require('../database');
const { sweepCache } = require('../audioCache');
const { sendErrorLog } = require('../errorLogger');

const { VOICEVOX_API_URL, CACHE_SWEEP_INTERVAL_HOURS, ITEMS_PER_PAGE, BOT_OWNER_ID } = process.env;
const itemsPerPage = parseInt(ITEMS_PER_PAGE, 10) || 25;

const OJT_SPEAKERS = [
    { name: 'メイ (標準)', speaker_uuid: 'ojt_mei_normal', styles: [{ id: 0, name: 'ノーマル' }] },
];

// ★ お知らせ・Tips定義
const SYSTEM_ANNOUNCEMENT = {
    // trueの場合、各所に表示されます
    enabled: true,
    
    // VC接続時にメッセージの末尾に追加される短いテキスト
    // ※ \n で改行可能。URLを含めると自動でリンクになります。
    vc_suffix: '\n\n💡 **News:** Webダッシュボードのベータ版が公開されました！設定や辞書登録がブラウザから行えます。\n🔗 **Dashboard:** [こちらをクリックしてアクセス](https://tts.ux-labs.jp)',
    
    // ダッシュボードの上部に表示される内容
    dashboard: {
        title: '辞書のエクスポート/インポートに対応しました。',
        message: '他のbotからのインポート、UX TTSから他のbotへのエクスポートができます。',
        type: 'info' // 'info', 'warning', 'danger', 'success'
    }
};

function getAnnouncement() {
    return SYSTEM_ANNOUNCEMENT;
}

function resetMonthlyUsageCounts(client) {
    const currentMonth = getCurrentMonth();
    try {
        const allUsage = getAllGuildUsage();
        let resetCount = 0;
        for (const usage of allUsage) {
            if (usage.last_reset_month !== currentMonth) {
                resetGuildUsage(usage.guild_id, currentMonth);
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

// UI作成 (Speaker)
async function createSpeakerUIPayload(client, page, userId, type = 'voicevox') {
    const speakerList = (type === 'ojt') ? OJT_SPEAKERS : (client.speakerCache || []);
    const typeName = (type === 'ojt') ? 'Open JTalk' : 'VOICEVOX';
    const otherType = (type === 'ojt') ? 'voicevox' : 'ojt';
    const otherTypeName = (type === 'ojt') ? 'VOICEVOX' : 'Open JTalk';

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
        .setDescription(`下のメニューからキャラクターを選択してください。\n現在のモード: **${typeName}**`)
        .setColor(type === 'ojt' ? 0xFF9900 : 0x00FF00)
        .setFooter({ text: `ページ ${page} / ${totalPages}` });
        
    const characterOptions = speakersOnPage.map(speaker => ({
        label: speaker.name, 
        description: `スタイル数: ${speaker.styles.length}`, 
        value: speaker.speaker_uuid,
    }));
    
    if (characterOptions.length === 0) {
        embed.setDescription('表示できる話者がありません。');
        return { content: '', embeds: [embed], components: [], flags: [MessageFlags.Ephemeral] };
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`select_character_page_${page}_${userId}_${type}`) 
        .setPlaceholder(`${typeName} キャラクターを選択...`).addOptions(characterOptions);
    const menuRow = new ActionRowBuilder().addComponents(selectMenu);
    
    const buttonRow = new ActionRowBuilder();
    const prevButton = new ButtonBuilder()
        .setCustomId(`speaker_page_${page - 1}_${userId}_${type}`)
        .setLabel('◀ 前へ').setStyle(ButtonStyle.Primary).setDisabled(page === 1); 
    const nextButton = new ButtonBuilder()
        .setCustomId(`speaker_page_${page + 1}_${userId}_${type}`)
        .setLabel('次へ ▶').setStyle(ButtonStyle.Primary).setDisabled(page === totalPages); 
    const switchButton = new ButtonBuilder()
        .setCustomId(`speaker_type_switch_${otherType}_${userId}`)
        .setLabel(`${otherTypeName} に切り替え`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄');

    buttonRow.addComponents(prevButton, switchButton, nextButton);
    
    return { content: '', embeds: [embed], components: [menuRow, buttonRow], flags: [MessageFlags.Ephemeral] };
}

async function createAutojoinMenuPayload(guildId, userId, memberPermissions) {
    const userSettings = getUserSettings(guildId, userId);
    const guildSettings = getGuildSettings(guildId);
    const ignoreChannels = getIgnoreChannels(guildId);
    const allowChannels = getAllowChannels(guildId);
    const pairs = getAllChannelPairs(guildId);

    const isAdmin = memberPermissions.has(PermissionsBitField.Flags.Administrator) || userId === BOT_OWNER_ID;

    // 状態判定
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
        return { embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] };
    }

    return { embeds: [embed], components: [row1], flags: [MessageFlags.Ephemeral] };
}

module.exports = {
    resetMonthlyUsageCounts,
    fetchSpeakerCache,
    updateActivity,
    createSpeakerUIPayload,
    createAutojoinMenuPayload,
    getAnnouncement, // ★ Export
    OJT_SPEAKERS
};