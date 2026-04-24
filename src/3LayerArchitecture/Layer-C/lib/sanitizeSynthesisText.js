'use strict';

/**
 * Layer-C /synthesize 用テキストサニタイズ（孤立サロゲート除去、OJT 時の BMP 外・記号除去）。
 * 呼び出し側で `!text` のときは 400 を返すこと。
 *
 * @param {unknown} text
 * @param {boolean} useOjt
 * @returns {{ ok: true, text: string } | { ok: false, code: 'empty_after_sanitisation' }}
 */
function sanitizeSynthesisText(text, useOjt) {
    let sanitisedText = String(text)
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/[\uFFFE\uFFFF]/g, '');

    if (useOjt) {
        sanitisedText = sanitisedText
            .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
            .replace(/[\u{2600}-\u{27BF}\u{2B50}-\u{2B55}]/gu, '')
            .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '');
    }

    sanitisedText = sanitisedText.trim();
    if (!sanitisedText) {
        return { ok: false, code: 'empty_after_sanitisation' };
    }

    return { ok: true, text: sanitisedText };
}

module.exports = { sanitizeSynthesisText };
