const path = require('path');
const fs = require('fs');
const { getDictionaryEntries, getUserPersonalDictionaryEntries } = require('../database');

// --- 高度辞書 (Advanced Dictionary) の読み込み ---
let advancedDict = [];
const advancedDictPath = path.join(__dirname, '../data/advanced_dictionary.json');

function loadAdvancedDictionary() {
    try {
        if (fs.existsSync(advancedDictPath)) {
            const rawData = fs.readFileSync(advancedDictPath, 'utf8');
            advancedDict = JSON.parse(rawData);
            console.log(`[Dictionary] 高度辞書を読み込みました: ${advancedDict.length} 件のルール`);
        } else {
            const dir = path.dirname(advancedDictPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(advancedDictPath, '[]', 'utf8');
            console.log('[Dictionary] 高度辞書ファイル(advanced_dictionary.json)を新規作成しました。');
        }
    } catch (e) {
        console.error('[Dictionary] 高度辞書の読み込みエラー:', e.message);
        advancedDict = [];
    }
}

// 初回読み込み
loadAdvancedDictionary();

/**
 * 高度な辞書（文脈判断）を適用する
 *
 * 各出現箇所ごとに「直前 CONTEXT_BEFORE 文字 + 直後 CONTEXT_AFTER 文字」の
 * ローカルコンテキストでキーワードを検索し、読みを決定する。
 * これにより同一文中に同じパターンが複数出現しても、位置ごとに異なる読みを適用できる。
 */
/**
 * @param {string} text
 * @param {object[]} dict advanced dictionary entries (same shape as advanced_dictionary.json)
 */
function applyAdvancedDictionaryWithDict(text, dict) {
    if (!dict || dict.length === 0) return text;

    const CONTEXT_BEFORE = 10;
    const CONTEXT_AFTER = 2;
    let processedText = text;

    for (const entry of dict) {
        if (!processedText.includes(entry.pattern)) continue;

        let result = '';
        let lastIndex = 0;
        let searchFrom = 0;

        while (searchFrom <= processedText.length) {
            const idx = processedText.indexOf(entry.pattern, searchFrom);
            if (idx === -1) break;

            // 出現箇所周辺のローカルコンテキストを取得
            const ctxStart = Math.max(0, idx - CONTEXT_BEFORE);
            const ctxEnd = Math.min(processedText.length, idx + entry.pattern.length + CONTEXT_AFTER);
            const localContext = processedText.substring(ctxStart, ctxEnd);

            // ローカルコンテキストでキーワードマッチし読みを決定
            let replaceRead = entry.default;
            for (const rule of entry.rules || []) {
                if (rule.keywords.some(kw => localContext.includes(kw))) {
                    replaceRead = rule.read;
                    break;
                }
            }

            result += processedText.substring(lastIndex, idx) + (replaceRead || entry.pattern);
            lastIndex = idx + entry.pattern.length;
            searchFrom = lastIndex;
        }

        result += processedText.substring(lastIndex);
        processedText = result;
    }
    return processedText;
}

function applyAdvancedDictionary(text) {
    return applyAdvancedDictionaryWithDict(text, advancedDict);
}

/**
 * 辞書適用処理 (メイン)
 * ギルド共有辞書のあと、発言者本人のマイ辞書で上書き（同一語はマイ辞書が優先）
 */
async function replaceSlang(guildId, authorUserId, text) {
    text = applyAdvancedDictionary(text);

    try {
        const [guildEntries, personalEntries] = await Promise.all([
            getDictionaryEntries(guildId),
            authorUserId ? getUserPersonalDictionaryEntries(authorUserId) : Promise.resolve([])
        ]);

        const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const replaceMap = {};
        for (const e of guildEntries || []) {
            if (e && e.word) replaceMap[e.word] = e.read_as;
        }
        for (const e of personalEntries || []) {
            if (e && e.word) replaceMap[e.word] = e.read_as;
        }

        const words = Object.keys(replaceMap).filter(Boolean);
        if (words.length === 0) return text;

        words.sort((a, b) => b.length - a.length);
        const pattern = new RegExp(words.map(escapeRegExp).join('|'), 'g');
        return text.replace(pattern, (matched) => replaceMap[matched] || matched);
    } catch (e) {
        console.error(`[Dictionary Error] Guild: ${guildId} Author: ${authorUserId}`, e);
        return text;
    }
}

module.exports = {
    replaceSlang,
    applyDictionary: (text, guildId, authorUserId) => replaceSlang(guildId, authorUserId, text),
    applyAdvancedDictionaryWithDict
};