const path = require('path');
const fs = require('fs');
const { getDictionaryEntries } = require('../database');

// --- 高度辞書 (Advanced Dictionary) の読み込み ---
let advancedDict = [];
// ★ 修正: 正しいパス (../data/...) に変更しました
const advancedDictPath = path.join(__dirname, '../data/advanced_dictionary.json');

function loadAdvancedDictionary() {
    try {
        if (fs.existsSync(advancedDictPath)) {
            const rawData = fs.readFileSync(advancedDictPath, 'utf8');
            advancedDict = JSON.parse(rawData);
            console.log(`[Dictionary] 高度辞書を読み込みました: ${advancedDict.length} 件のルール`);
        } else {
            // ファイルがない場合はディレクトリを作成して空の配列で初期化
            const dir = path.dirname(advancedDictPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(advancedDictPath, '[]', 'utf8');
            console.log('[Dictionary] 高度辞書ファイル(advanced_dictionary.json)を新規作成しました。');
        }
    } catch (e) {
        console.error('[Dictionary] 高度辞書の読み込みエラー:', e.message);
        advancedDict = []; // エラー時は空にする
    }
}

// 初回読み込み
loadAdvancedDictionary();


/**
 * 高度な辞書（文脈判断）を適用する
 * @param {string} text 
 * @returns {string} 置換後のテキスト
 */
function applyAdvancedDictionary(text) {
    if (!advancedDict || advancedDict.length === 0) return text;

    let processedText = text;

    for (const entry of advancedDict) {
        // ターゲット単語がテキストに含まれている場合のみ処理
        if (processedText.includes(entry.pattern)) {
            let replaceRead = entry.default; // デフォルトの読み

            // ルールを上から順にチェック
            for (const rule of entry.rules) {
                // keywordsのいずれかがテキスト全体に含まれているかチェック
                // (部分一致でも検知するため、単純な includes で判定)
                const match = rule.keywords.some(keyword => processedText.includes(keyword));
                if (match) {
                    replaceRead = rule.read;
                    break; // マッチしたらその読みで確定し、次のルールのチェックはしない
                }
            }

            // 置換を実行 (replaceAllで一括置換)
            if (replaceRead) {
                // 無限ループ防止のため、置換後の文字列にpatternが含まれない、あるいは読みが異なる場合のみ
                // ここでは単純に置換します（ひらがな化されるため通常は問題なし）
                processedText = processedText.replaceAll(entry.pattern, replaceRead);
            }
        }
    }
    return processedText;
}


/**
 * テキスト内の単語を辞書に基づいて置換する
 * 1. 高度な辞書（文脈判断）
 * 2. ユーザー辞書（単純置換）
 * の順で適用します。
 * * @param {string} text 元のテキスト
 * @param {string} guildId サーバーID
 * @returns {string} 置換後のテキスト
 */
function applyDictionary(text, guildId) {
    // 1. 高度な辞書 (Advanced Dictionary)
    text = applyAdvancedDictionary(text);

    // 2. ユーザー辞書 (User Dictionary)
    const entries = getDictionaryEntries(guildId);
    if (entries.length === 0) return text;

    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(entries.map(e => escapeRegExp(e.word)).join('|'), 'g');
    const replaceMap = {};
    entries.forEach(e => { replaceMap[e.word] = e.read_as; });

    return text.replace(pattern, (matched) => {
        return replaceMap[matched] || matched;
    });
}

module.exports = { applyDictionary };