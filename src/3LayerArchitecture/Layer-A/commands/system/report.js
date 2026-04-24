const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
// 統計マネージャーからレイテンシ取得関数をインポート
const { getAverageLatencyStats } = require('../../utils/statsManager');
const { createStatusMessage } = require('../../utils/helpers');
const { getGuildErrors, getGlobalErrors, getErrorSummary } = require('../../errorLogger');

// BotオーナーID (緊急時のバックドア用、基本はサーバー管理者権限で判定)
const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('report')
        .setDescription('システムレポートを表示します。（管理者専用）')
        .addSubcommand(sub =>
            sub.setName('stats')
                .setDescription('システム統計レポート(CSV)を集計して表示します。')
                .addIntegerOption(option =>
                    option.setName('days')
                        .setDescription('集計する過去の日数（デフォルト: 7）')
                        .setMinValue(1)
                        .setMaxValue(365)))
        .addSubcommand(sub =>
            sub.setName('errors')
                .setDescription('直近のエラーログを表示します。')
                .addStringOption(option =>
                    option.setName('scope')
                        .setDescription('表示範囲')
                        .addChoices(
                            { name: 'このサーバー', value: 'guild' },
                            { name: '全サーバー', value: 'global' }
                        ))
                .addIntegerOption(option =>
                    option.setName('count')
                        .setDescription('表示件数（デフォルト: 10）')
                        .setMinValue(1)
                        .setMaxValue(25))
                .addIntegerOption(option =>
                    option.setName('hours')
                        .setDescription('統計サマリーの集計時間（デフォルト: 24時間）')
                        .setMinValue(1)
                        .setMaxValue(168))),

    async execute(interaction, client) {
        // 1. 権限チェック
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isOwner = interaction.user.id === BOT_OWNER_ID;

        if (!isAdmin && !isOwner) {
            return interaction.reply(createStatusMessage('error', 'このコマンドは管理者のみ実行できます。', { flags: [MessageFlags.Ephemeral] }));
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'errors') {
            return handleErrors(interaction);
        }
        return handleStats(interaction);
    }
};

// ==========================================
// エラーログ表示
// ==========================================
async function handleErrors(interaction) {
    const scope = interaction.options.getString('scope') || 'guild';
    const count = interaction.options.getInteger('count') || 10;
    const hours = interaction.options.getInteger('hours') || 24;
    const guildId = interaction.guildId;

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const isGuildScope = scope === 'guild';
    const errors = isGuildScope
        ? getGuildErrors(guildId, count)
        : getGlobalErrors(count);
    const summary = getErrorSummary(isGuildScope ? guildId : null, hours);

    // --- サマリー Embed ---
    const summaryEmbed = new EmbedBuilder()
        .setTitle(`${isGuildScope ? 'このサーバー' : '全サーバー'}のエラーサマリー`)
        .setColor(summary.total > 0 ? 0xFF6B35 : 0x2ECC71)
        .setDescription(`過去 **${hours}** 時間の集計`)
        .addFields(
            { name: 'エラー件数', value: `${summary.total} 件`, inline: true }
        )
        .setTimestamp();

    // 発生場所の内訳
    const placeEntries = Object.entries(summary.byPlace).sort((a, b) => b[1] - a[1]);
    if (placeEntries.length > 0) {
        const placeText = placeEntries.map(([place, cnt]) => `${place}: **${cnt}**`).join('\n');
        summaryEmbed.addFields({ name: '発生場所 内訳', value: placeText, inline: true });
    }

    // エラー種別の内訳
    const msgEntries = Object.entries(summary.byMessage).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (msgEntries.length > 0) {
        const msgText = msgEntries.map(([msg, cnt]) => `\`${msg}\`: **${cnt}**`).join('\n');
        summaryEmbed.addFields({ name: 'エラー種別 TOP5', value: msgText, inline: false });
    }

    const embeds = [summaryEmbed];

    // --- 個別エラーログ Embed ---
    if (errors.length > 0) {
        const logEmbed = new EmbedBuilder()
            .setTitle(`直近のエラーログ (${errors.length} 件)`)
            .setColor(0xFF4444);

        let logText = '';
        for (const err of errors) {
            const time = new Date(err.timestamp);
            const timeStr = `${String(time.getMonth() + 1).padStart(2, '0')}/${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            let line = `\`${timeStr}\` **${err.message}**`;
            if (err.place) line += ` [${err.place}]`;
            if (err.details) {
                const detailShort = String(err.details).substring(0, 80);
                line += `\n  > ${detailShort}`;
            }
            if (err.workerUrl) line += `\n  > Worker: \`${err.workerUrl}\``;
            line += '\n';

            // Embed の文字数制限 (4096) を超えないようにする
            if (logText.length + line.length > 3800) {
                logText += `\n...他 ${errors.length - logText.split('\n').filter(l => l.startsWith('`')).length} 件省略`;
                break;
            }
            logText += line;
        }

        logEmbed.setDescription(logText);
        embeds.push(logEmbed);
    } else {
        summaryEmbed.addFields({ name: 'ログ', value: 'エラーログはありません。', inline: false });
    }

    await interaction.editReply({ embeds });
}

// ==========================================
// 統計レポート (既存)
// ==========================================
async function handleStats(interaction) {
    const days = interaction.options.getInteger('days') || 7;
    const csvPath = path.join(__dirname, '../../reports/system_report.csv');

    if (!fs.existsSync(csvPath)) {
        return interaction.reply(createStatusMessage('warning', 'レポートファイルがまだ生成されていません。', { flags: [MessageFlags.Ephemeral] }));
    }

    await interaction.deferReply();

    try {
        // CSV読み込み
        const rawData = fs.readFileSync(csvPath, 'utf8');
        const lines = rawData.trim().split('\n');
        // ヘッダーを除去
        const header = lines.shift();

        // カラム定義 (index.jsでの書き込み順序)
        // 0:Timestamp, 1:StartTime, 2:EndTime, 3:DurationMin, 4:TotalRequests,
        // 5:ReqPerMin, 6:VoicevoxRequests, 7:OjtRequests, 8:CacheHits, 9:CacheMisses,
        // 10:HitRate, 11:ActiveConnections

        const now = new Date();
        const thresholdDate = new Date();
        thresholdDate.setDate(now.getDate() - days);

        let totalReq = 0;
        let totalVvx = 0;
        let totalOjt = 0;
        let totalHits = 0;
        let totalMisses = 0;

        // 日別集計用マップ
        const dailyStats = {};
        let recordCount = 0;

        for (const line of lines) {
            if (!line) continue;
            const cols = line.split(',');
            const timestamp = new Date(cols[0]);

            // 指定期間より古いデータはスキップ
            if (timestamp < thresholdDate) continue;

            const dateStr = cols[0].split('T')[0]; // YYYY-MM-DD

            const req = parseInt(cols[4], 10) || 0;
            const vvx = parseInt(cols[6], 10) || 0;
            const ojt = parseInt(cols[7], 10) || 0;
            const hits = parseInt(cols[8], 10) || 0;
            const misses = parseInt(cols[9], 10) || 0;

            totalReq += req;
            totalVvx += vvx;
            totalOjt += ojt;
            totalHits += hits;
            totalMisses += misses;
            recordCount++;

            if (!dailyStats[dateStr]) {
                dailyStats[dateStr] = { req: 0, vvx: 0, ojt: 0 };
            }
            dailyStats[dateStr].req += req;
            dailyStats[dateStr].vvx += vvx;
            dailyStats[dateStr].ojt += ojt;
        }

        if (recordCount === 0) {
            return interaction.editReply(createStatusMessage('info', `過去 ${days} 日間のデータはありませんでした。`));
        }

        // 統計計算
        const totalCacheAccess = totalHits + totalMisses;
        const avgHitRate = totalCacheAccess > 0 ? ((totalHits / totalCacheAccess) * 100).toFixed(1) : '0.0';

        // レイテンシ統計の取得 (指定日数 × 24時間)
        const latencyStats = getAverageLatencyStats(days * 24);
        const latencyField = latencyStats.count > 0
            ? `平均: **${latencyStats.avg}ms**\n最小: ${latencyStats.min}ms / 最大: ${latencyStats.max}ms`
            : 'データなし';

        // 日別推移のテキストグラフ作成 (直近10日分まで)
        const sortedDates = Object.keys(dailyStats).sort();
        const displayDates = sortedDates.slice(-10);

        let graphText = '```\n';
        for (const date of displayDates) {
            const d = dailyStats[date];
            // 簡易的な棒グラフ (リクエスト数に応じて # を表示)
            const bar = '#'.repeat(Math.ceil(d.req / 10)); // 10req = 1# (調整可)
            // スペース調整
            graphText += `${date.substring(5)}: ${String(d.req).padStart(4)} req [V:${d.vvx}/O:${d.ojt}]\n`;
        }
        if (sortedDates.length > 10) {
            graphText = `...他 ${sortedDates.length - 10} 日分省略\n` + graphText;
        }
        graphText += '```';

        // Embed作成
        const embed = new EmbedBuilder()
            .setTitle(`📊 システム長期統計レポート`)
            .setDescription(`過去 **${days}** 日間の集計結果`)
            .setColor(0x00AAFF)
            .addFields(
                { name: '総リクエスト数', value: `${totalReq.toLocaleString()} 回`, inline: true },
                { name: 'キャッシュヒット率', value: `${avgHitRate}%`, inline: true },
                { name: '平均生成レイテンシ', value: latencyField, inline: true }, // 追加したフィールド
                { name: 'エンジン利用比率', value: `VOICEVOX: **${totalVvx}**\nOpen JTalk: **${totalOjt}**`, inline: false },
                { name: '日別リクエスト推移', value: graphText }
            )
            .setTimestamp();

        // CSVダウンロードボタン
        const downloadButton = new ButtonBuilder()
            .setCustomId('download_csv')
            .setLabel('CSVをダウンロード')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📥');

        const row = new ActionRowBuilder().addComponents(downloadButton);

        // CSVファイルを添付するための準備

        const csvAttachment = new AttachmentBuilder(csvPath, { name: 'system_report.csv' });

        await interaction.editReply({
            embeds: [embed],
            files: [csvAttachment] // ファイルを添付
        });

    } catch (e) {
        console.error(e);
        await interaction.editReply(createStatusMessage('error', 'レポートの集計中にエラーが発生しました。'));
    }
}
