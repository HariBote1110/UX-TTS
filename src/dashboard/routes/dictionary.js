const express = require('express');
const router = express.Router({ mergeParams: true });
const multer = require('multer');
const { checkAuth } = require('../middleware/auth');
const { 
    getDictionaryEntries, 
    addDictionaryEntry, 
    removeDictionaryEntry,
    importDictionary,
    clearDictionary
} = require('../../database');

// ファイルアップロード設定 (メモリ上に保持)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB制限
});

module.exports = () => {
    router.post('/add', checkAuth, (req, res) => {
        const { word, read } = req.body;
        if (word && read) addDictionaryEntry(req.params.guildId, word, read);
        res.redirect(`/dashboard/${req.params.guildId}#dictionary`);
    });

    router.post('/delete', checkAuth, (req, res) => {
        if (req.body.word) removeDictionaryEntry(req.params.guildId, req.body.word);
        res.redirect(`/dashboard/${req.params.guildId}#dictionary`);
    });

    // ★ インポート処理 (新規追加)
    router.post('/import', checkAuth, upload.single('dictFile'), async (req, res) => {
        const guildId = req.params.guildId;
        
        try {
            const file = req.file;
            const mode = req.body.importMode || 'merge'; // 'merge' or 'replace'

            if (!file) throw new Error('ファイルが選択されていません。');

            // ファイル読み込み (UTF-8前提)
            let fileContent = file.buffer.toString('utf-8');
            // BOM除去 (Windowsのメモ帳などで保存された場合用)
            if (fileContent.charCodeAt(0) === 0xFEFF) {
                fileContent = fileContent.slice(1);
            }

            let entries = [];

            // 1. JSONとして解析を試みる
            try {
                const json = JSON.parse(fileContent);
                if (Array.isArray(json)) {
                    // パターンA: UX TTS形式 / 一般的な配列 [{word:..., read:...}]
                    entries = json.map(item => ({ 
                        word: item.word, 
                        read: item.read || item.read_as || item.yomi 
                    })).filter(e => e.word && e.read);
                } else if (json.kind === 'com.kuroneko6423.kuronekottsbot.dictionary' && json.data) {
                    // パターンB: VOICEROID形式
                    entries = Object.entries(json.data).map(([k, v]) => ({ word: k, read: v }));
                } else {
                    // パターンC: 単純なKey-Valueオブジェクト {"単語": "読み"}
                    entries = Object.entries(json).map(([k, v]) => ({ word: k, read: String(v) }));
                }
            } catch (e) {
                // 2. JSONでなければCSV/TSVとして解析
                const lines = fileContent.split(/\r?\n/);
                lines.forEach(line => {
                    if (!line.trim()) return;
                    // カンマまたはタブ区切り
                    let parts = line.split(',');
                    if (parts.length < 2) parts = line.split('\t'); // タブ区切りを試行
                    if (parts.length < 2) parts = line.split('=');  // イコール区切りを試行
                    
                    if (parts.length >= 2) {
                        const word = parts[0].trim();
                        const read = parts[1].trim();
                        if (word && read) {
                            entries.push({ word, read });
                        }
                    }
                });
            }

            if (entries.length === 0) {
                throw new Error('有効な辞書データが見つかりませんでした。形式を確認してください。');
            }

            // モードに応じた処理
            if (mode === 'replace') {
                clearDictionary(guildId);
            }

            // DBへ登録
            const count = importDictionary(guildId, entries);
            
            res.redirect(`/dashboard/${guildId}?success=${encodeURIComponent(`${count}件の単語をインポートしました (${mode === 'replace' ? '全置換' : '追加更新'})`)}#dictionary`);

        } catch (error) {
            console.error('[Dictionary Import Error]', error);
            res.redirect(`/dashboard/${guildId}?error=${encodeURIComponent('インポート失敗: ' + error.message)}#dictionary`);
        }
    });

    router.get('/export', checkAuth, (req, res) => {
        const { guildId } = req.params;
        const { format } = req.query;
        const entries = getDictionaryEntries(guildId);
        let buffer, fileName, contentType = 'application/json';

        if (format === 'voiceroid') {
            const dataMap = {};
            entries.forEach(e => { dataMap[e.word] = e.read_as; });
            const exportObj = { kind: "com.kuroneko6423.kuronekottsbot.dictionary", version: 0, data: dataMap };
            const jsonStr = JSON.stringify(exportObj, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_voiceroid.json';
        } else if (format === 'shovel') {
            // Shovel形式などはShift-JISかUTF-16LEが一般的だが、ここではUTF-16LE(BOM付)にする
            const csvLines = entries.map(e => `${e.word}, ${e.read_as}`);
            const csvStr = csvLines.join('\r\n');
            const bom = Buffer.from([0xFF, 0xFE]);
            const content = Buffer.from(csvStr, 'utf16le');
            buffer = Buffer.concat([bom, content]);
            fileName = 'dictionary.dict';
            contentType = 'text/plain';
        } else {
            const data = entries.map(e => ({ word: e.word, read: e.read_as }));
            const jsonStr = JSON.stringify(data, null, 2);
            buffer = Buffer.from(jsonStr, 'utf-8');
            fileName = 'dictionary_uxtts.json';
        }
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', contentType);
        res.send(buffer);
    });

    return router;
};