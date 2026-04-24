// ユーザーごとの1日1回フィードバック制限を管理するモジュール (メモリ内、再起動でリセット)
const lastFeedbackDate = new Map(); // userId -> 'YYYY-MM-DD'

function getDateStr() {
    return new Date().toISOString().slice(0, 10);
}

function canSubmit(userId) {
    return lastFeedbackDate.get(String(userId)) !== getDateStr();
}

function markSubmitted(userId) {
    lastFeedbackDate.set(String(userId), getDateStr());
}

module.exports = { canSubmit, markSubmitted };
