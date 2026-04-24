const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');

// BotオーナーID (緊急時のバックドア用、基本はサーバー管理者権限で判定)
const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('report')
        .setDescription('システムレポート(CSV)を集計して統計を表示します。（管理者専用）')
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('集計する過去の日数（デフォルト: 7）')
                .setMinValue(1)
                .setMaxValue(365)),

    async execute(interaction, client) {
        // 1. 権限チェック
        const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        const isOwner = interaction.user.id === BOT_OWNER_ID;
        
        if (!isAdmin && !isOwner) {
            return interaction.reply({ content: '❌ このコマンドは管理者のみ実行できます。', flags: [MessageFlags.Ephemeral] });
        }

        const days = interaction.options.getInteger('days') || 7;
        const csvPath = path.join(__dirname, '../../reports/system_report.csv');

        if (!fs.existsSync(csvPath)) {
            return interaction.reply({ content: '⚠️ レポートファイルがまだ生成されていません。', flags: [MessageFlags.Ephemeral] });
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
                return interaction.editReply(`ℹ️ 過去 ${days} 日間のデータはありませんでした。`);
            }

            // 統計計算
            const totalCacheAccess = totalHits + totalMisses;
            const avgHitRate = totalCacheAccess > 0 ? ((totalHits / totalCacheAccess) * 100).toFixed(1) : '0.0';

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
            // Interaction応答には直接添付できないケースもあるため、ボタン応答で処理するか、ここで添付してしまうか。
            // 今回はシンプルに、ボタンが押されたらハンドラ側で処理...ではなく、
            // 「ダウンロード用ボタン」を作るのが少し手間（ハンドラ追加が必要）なので、
            // 今回は**最初からファイルを添付して送る**形にします。
            
            const csvAttachment = new AttachmentBuilder(csvPath, { name: 'system_report.csv' });

            await interaction.editReply({ 
                embeds: [embed], 
                files: [csvAttachment], // ファイルを添付
                content: '詳細なデータは添付のCSVファイルをご確認ください。' 
            });

        } catch (e) {
            console.error(e);
            await interaction.editReply('❌ レポートの集計中にエラーが発生しました。');
        }
    }
};