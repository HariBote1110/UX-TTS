const fs = require('fs');
const path = require('path');
// cacheDBインスタンスと関連するステートメントを直接インポート
const { cacheDB } = require('./database'); 

const cacheDir = path.join(__dirname, 'audio_cache');

function rebuildCacheIndex() {
    console.log('キャッシュインデックスの再構築を開始します...');

    if (!fs.existsSync(cacheDir)) {
        console.log('audio_cache ディレクトリが存在しません。処理をスキップします。');
        return;
    }
    
    // 必要なステートメントを準備
    let stmtGetAllDbEntries, stmtDeleteDbEntry, stmtCheckDbEntry;
    try {
        stmtGetAllDbEntries = cacheDB.prepare('SELECT cache_key, file_path FROM audio_cache WHERE file_path IS NOT NULL');
        stmtDeleteDbEntry = cacheDB.prepare('DELETE FROM audio_cache WHERE cache_key = ?');
        stmtCheckDbEntry = cacheDB.prepare('SELECT cache_key FROM audio_cache WHERE cache_key = ?');
    } catch (e) {
        console.error('DBステートメントの準備に失敗しました:', e.message);
        console.error('エラー: データベーススキーマが古い可能性があります。database/cache.sqlite3 を削除してBotを再起動してください。');
        return;
    }


    // --- 1. DB -> ファイルの整合性チェック ---
    // (DBに存在するが、ファイルがないレコードを削除)
    console.log('[1/2] データベースのクリーニング中 (実在しないファイルのエントリを削除)...');
    let dbEntries;
    try {
        dbEntries = stmtGetAllDbEntries.all();
    } catch (e) {
        console.error('DBからのエントリ取得に失敗しました:', e.message);
        return;
    }
    
    let deletedDbEntries = 0;
    
    for (const entry of dbEntries) {
        if (!entry.file_path || !fs.existsSync(entry.file_path)) {
            stmtDeleteDbEntry.run(entry.cache_key);
            deletedDbEntries++;
        }
    }
    console.log(`-> ${deletedDbEntries} 件の無効なDBエントリを削除しました。`);

    // --- 2. ファイル -> DBの整合性チェック ---
    // (ファイルは存在するが、DBにない .wav ファイルを削除)
    console.log('[2/2] キャッシュディレクトリのクリーニング中 (DBにないキャッシュファイルを削除)...');
    let wavFiles;
    try {
        wavFiles = fs.readdirSync(cacheDir).filter(f => f.endsWith('.wav'));
    } catch (e) {
        console.error('audio_cache ディレクトリの読み取りに失敗しました:', e.message);
        return;
    }
    
    let deletedFiles = 0;

    for (const file of wavFiles) {
        const cacheKey = file.replace('.wav', '');
        const entry = stmtCheckDbEntry.get(cacheKey);
        
        if (!entry) {
            // DBにエントリが存在しない
            try {
                fs.unlinkSync(path.join(cacheDir, file));
                deletedFiles++;
            } catch (e) {
                console.error(`ファイル削除に失敗: ${file}`, e.message);
            }
        }
    }
    console.log(`-> ${deletedFiles} 件の孤立したキャッシュファイルを削除しました。`);

    console.log('キャッシュインデックスの再構築が完了しました。');
}

// スクリプトとして直接実行された場合のみ実行
if (require.main === module) {
    rebuildCacheIndex();
}