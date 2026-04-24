// database.js の addLicenseKey 関数を呼び出すだけのスクリプト
const { addLicenseKey } = require('./database');

const keyToAdd = process.argv[2]; // コマンドライン引数からキーを取得

if (!keyToAdd) {
    console.error('エラー: 追加するライセンスキーをコマンドライン引数で指定してください。');
    console.log('例: node add-key.js YOUR_NEW_LICENSE_KEY');
    process.exit(1);
}

// 最大アクティベーション回数を指定したい場合は第3引数で (例: node add-key.js KEY 10)
const maxActivations = parseInt(process.argv[3], 10) || 5; 

addLicenseKey(keyToAdd, maxActivations);

console.log('スクリプト完了。');