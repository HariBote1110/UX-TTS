const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/daily_stats.json');

// メモリ内キャッシュ
let data = {};
let saveTimer = null;

// 起動時にファイルからロード
function load() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[DailyStats] Load error:', e.message);
        data = {};
    }
}

function save() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
        console.error('[DailyStats] Save error:', e.message);
    }
}

// 書き込みをまとめて5秒後に保存
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        save();
    }, 5000);
}

function getDateStr(date = new Date()) {
    return date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

load();

/**
 * 指定ギルドの今日の読み上げ文字数を加算する
 * @param {string} guildId
 * @param {number} chars
 */
function record(guildId, chars) {
    const today = getDateStr();
    if (!data[guildId]) data[guildId] = {};
    data[guildId][today] = (data[guildId][today] || 0) + chars;
    scheduleSave();
}

/**
 * 指定ギルドの直近N日分の使用履歴を返す
 * @param {string} guildId
 * @param {number} days
 * @returns {{ date: string, chars: number }[]}
 */
function getHistory(guildId, days = 7) {
    const guildData = data[guildId] || {};
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = getDateStr(d);
        result.push({ date: dateStr, chars: guildData[dateStr] || 0 });
    }
    return result;
}

module.exports = { record, getHistory };
