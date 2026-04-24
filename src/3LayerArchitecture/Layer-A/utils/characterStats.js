const fs = require('fs');
const path = require('path');

/**
 * キャラクター使用統計を管理するクラス
 * speakerIdごとの使用回数を追跡し、使用頻度の高いキャラクターを特定する
 */
class CharacterStats {
    constructor(options = {}) {
        this.statsFile = options.statsFile || path.join(__dirname, '../data/character_usage.json');
        this.stats = {}; // { speakerId: count }
        this.topCharacters = []; // Top 3のspeakerIdを保持

        this.loadStats();
        this.updateTopCharacters();
    }

    /**
     * ファイルから統計データを読み込む
     */
    loadStats() {
        try {
            if (fs.existsSync(this.statsFile)) {
                const data = fs.readFileSync(this.statsFile, 'utf8');
                this.stats = JSON.parse(data);
                console.log('[CharacterStats] Usage statistics loaded.');
            } else {
                console.log('[CharacterStats] No existing stats file. Starting fresh.');
            }
        } catch (e) {
            console.error('[CharacterStats] Failed to load stats:', e.message);
            this.stats = {};
        }
    }

    /**
     * ファイルに統計データを保存する
     */
    saveStats() {
        try {
            const dir = path.dirname(this.statsFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
        } catch (e) {
            console.error('[CharacterStats] Failed to save stats:', e.message);
        }
    }

    /**
     * 使用回数を記録
     * @param {number|string} speakerId 
     */
    recordUsage(speakerId) {
        if (!speakerId && speakerId !== 0) return;

        const key = String(speakerId);
        this.stats[key] = (this.stats[key] || 0) + 1;

        // 10回に1回、統計を保存してTop更新
        if (this.stats[key] % 10 === 0) {
            this.saveStats();
            this.updateTopCharacters();
        }
    }

    /**
     * Top 3の使用頻度キャラクターリストを更新
     */
    updateTopCharacters() {
        this.topCharacters = Object.entries(this.stats)
            .sort(([, countA], [, countB]) => countB - countA) // 降順ソート
            .slice(0, 3)
            .map(([id]) => parseInt(id, 10));

        if (this.topCharacters.length > 0) {
            console.log(`[CharacterStats] Top 3 characters: [${this.topCharacters.join(', ')}]`);
        }
    }

    /**
     * 指定されたspeakerIdが高頻度使用キャラクター（Top 3）に含まれるか判定
     * @param {number|string} speakerId 
     * @returns {boolean}
     */
    isHighUsage(speakerId) {
        if (!speakerId && speakerId !== 0) return false;
        return this.topCharacters.includes(parseInt(speakerId, 10));
    }

    /**
     * 全統計データを取得（レポート用など）
     * @returns {object}
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Top 3のキャラクターIDリストを取得
     * @returns {number[]}
     */
    getTopCharacters() {
        return [...this.topCharacters];
    }
}

const characterStatsSingleton = new CharacterStats();
module.exports = characterStatsSingleton;
module.exports.CharacterStats = CharacterStats;
